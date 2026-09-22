import { Router, type Request, type Response } from 'express';
import crypto from 'crypto';

interface OidcConfig {
  issuerUrl: string;
  clientId: string;
  maasUrl: string;
  modelServed: string;
  modelPath: string;
  redirectUri: string;
  discovery?: {
    authorization_endpoint: string;
    token_endpoint: string;
  };
}

interface OidcSession {
  apiKey: string;
  username: string;
  groups: string[];
  issuer: string;
  tokenExp: string;
  subscription: string;
  keyExpires: string;
  apiKeyMasked: string;
}

const config: OidcConfig = {
  issuerUrl: '',
  clientId: 'maas-oidc',
  maasUrl: '',
  modelServed: '',
  modelPath: '',
  redirectUri: '',
};

let session: OidcSession | null = null;
let pkceVerifier = '';

function decodeJwtClaims(jwt: string): Record<string, unknown> {
  const payload = jwt.split('.')[1]!;
  return JSON.parse(Buffer.from(payload, 'base64url').toString());
}

const CET_FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Berlin',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hour12: false,
});

function toCET(date: Date): string {
  return CET_FMT.format(date) + ' CET';
}

export async function initOidc(): Promise<boolean> {
  const issuerUrl = process.env['OIDC_ISSUER_URL'] || '';
  const clientId = process.env['OIDC_CLIENT_ID'] || 'maas-oidc';
  const maasUrl = process.env['MAAS_GATEWAY_URL'] || '';
  const modelServed = process.env['OIDC_MODEL_SERVED'] || 'qwen3-8b-fp8';
  const modelPath = process.env['OIDC_MODEL_PATH'] || 'qwen3-8b-fp8';
  const redirectUri = process.env['OIDC_REDIRECT_URI'] || '';

  if (!issuerUrl) {
    console.log('[oidc] OIDC_ISSUER_URL not set, OIDC tab disabled');
    return false;
  }

  config.issuerUrl = issuerUrl;
  config.clientId = clientId;
  config.maasUrl = maasUrl;
  config.modelServed = modelServed;
  config.modelPath = modelPath;
  config.redirectUri = redirectUri;

  try {
    const res = await fetch(`${issuerUrl}/.well-known/openid-configuration`);
    const data = await res.json() as Record<string, string>;
    config.discovery = {
      authorization_endpoint: data['authorization_endpoint']!,
      token_endpoint: data['token_endpoint']!,
    };
    console.log(`[oidc] configured: issuer=${issuerUrl}, client=${clientId}`);
    return true;
  } catch (e) {
    console.error(`[oidc] failed to fetch discovery document: ${e}`);
    return false;
  }
}

function deriveRedirectUri(req: Request): string {
  if (config.redirectUri) return config.redirectUri;
  const proto = req.get('x-forwarded-proto') || req.protocol;
  const host = req.get('x-forwarded-host') || req.get('host');
  return `${proto}://${host}/auth/callback`;
}

export function createOidcRouter(): Router {
  const router = Router();

  router.get('/api/oidc/config', (_req: Request, res: Response) => {
    res.json({
      enabled: !!config.discovery,
      issuer: config.issuerUrl,
      clientId: config.clientId,
    });
  });

  router.get('/api/oidc/session', (_req: Request, res: Response) => {
    if (!session) {
      res.json({ signedIn: false });
      return;
    }
    res.json({ signedIn: true, ...session });
  });

  router.get('/auth/login', (req: Request, res: Response) => {
    if (!config.discovery) {
      res.status(503).json({ error: 'OIDC not configured' });
      return;
    }

    const verifier = crypto.randomBytes(48).toString('base64url');
    pkceVerifier = verifier;
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const redirectUri = deriveRedirectUri(req);

    const params = new URLSearchParams({
      client_id: config.clientId,
      response_type: 'code',
      scope: 'openid groups',
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: crypto.randomBytes(12).toString('base64url'),
      prompt: 'login',
    });

    res.redirect(`${config.discovery.authorization_endpoint}?${params}`);
  });

  router.get('/auth/callback', async (req: Request, res: Response) => {
    const code = req.query['code'] as string;
    if (!code || !config.discovery) {
      res.status(400).send('Missing authorization code');
      return;
    }

    const redirectUri = deriveRedirectUri(req);

    try {
      const tokenRes = await fetch(config.discovery.token_endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: config.clientId,
          code,
          redirect_uri: redirectUri,
          code_verifier: pkceVerifier,
        }),
      });
      const tokenData = await tokenRes.json() as Record<string, unknown>;

      if (!tokenData['access_token']) {
        res.status(400).send(`Token exchange failed: ${JSON.stringify(tokenData)}`);
        return;
      }

      const oidcToken = tokenData['access_token'] as string;
      const claims = decodeJwtClaims(oidcToken);

      const keyRes = await fetch(`${config.maasUrl}/maas-api/v1/api-keys`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${oidcToken}`,
        },
        body: JSON.stringify({ name: 'maas-pulse-oidc', description: 'issued by maas-pulse UI', expiresIn: '8h' }),
      });
      const keyData = await keyRes.json() as Record<string, unknown>;

      if (!keyData['key']) {
        res.status(400).send(`API key exchange failed: ${JSON.stringify(keyData)}`);
        return;
      }

      const key = keyData['key'] as string;
      session = {
        apiKey: key,
        username: claims['preferred_username'] as string,
        groups: (claims['groups'] as string[]) || [],
        issuer: claims['iss'] as string,
        tokenExp: toCET(new Date((claims['exp'] as number) * 1000)),
        subscription: keyData['subscription'] as string,
        keyExpires: toCET(new Date(keyData['expiresAt'] as string)),
        apiKeyMasked: key.substring(0, 18) + '…',
      };

      res.redirect('/?tab=oidc');
    } catch (e) {
      res.status(500).send(`OIDC callback error: ${e}`);
    }
  });

  router.get('/auth/logout', (_req: Request, res: Response) => {
    session = null;
    res.redirect('/?tab=oidc');
  });

  router.post('/api/oidc/chat', async (req: Request, res: Response) => {
    if (!session) {
      res.status(401).json({ ok: false, error: 'Not signed in' });
      return;
    }

    const prompt = req.body.prompt || 'hello';
    try {
      const r = await fetch(`${config.maasUrl}/llm/${config.modelPath}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.apiKey}`,
        },
        body: JSON.stringify({
          model: config.modelServed,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 256,
        }),
      });
      const data = await r.json() as Record<string, unknown>;

      if (r.ok) {
        const choices = data['choices'] as Array<{ message: { content: string } }>;
        res.json({ ok: true, content: choices?.[0]?.message?.content || '', usage: data['usage'] });
      } else {
        res.json({ ok: false, status: r.status, body: data });
      }
    } catch (e) {
      res.json({ ok: false, status: 0, body: { error: String(e) } });
    }
  });

  router.post('/api/oidc/burst', async (_req: Request, res: Response) => {
    if (!session) {
      res.status(401).json({ ok: false, error: 'Not signed in' });
      return;
    }

    let ok = 0, limited = 0, other = 0, tokens = 0;
    for (let i = 0; i < 15; i++) {
      try {
        const r = await fetch(`${config.maasUrl}/llm/${config.modelPath}/v1/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${session.apiKey}`,
          },
          body: JSON.stringify({
            model: config.modelServed,
            messages: [{ role: 'user', content: 'hi' }],
            max_tokens: 4,
          }),
        });
        if (r.ok) {
          ok++;
          const d = await r.json() as Record<string, unknown>;
          const usage = d['usage'] as Record<string, number> | undefined;
          tokens += usage?.['total_tokens'] || 0;
        } else if (r.status === 429) {
          limited++;
          await r.text();
        } else {
          other++;
          await r.text();
        }
      } catch {
        other++;
      }
    }

    res.json({ ok, limited, other, tokens });
  });

  return router;
}
