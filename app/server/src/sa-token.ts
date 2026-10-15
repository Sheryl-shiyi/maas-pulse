import https from 'https';
import fs from 'fs';

/**
 * Mints short-lived tokens for the demo identities through the Kubernetes TokenRequest
 * API, so the traffic generator needs no MaaS API keys at all.
 *
 * Keys were a database row that could stop working silently — three of six did, with no
 * recoverable reason — and could only be created by clicking through a dashboard. A
 * ServiceAccount token is issued on demand and never has to be stored anywhere. The
 * gateway accepts it because the AuthConfig enables `openshift-identities`, which
 * resolves the bearer through kubernetesTokenReview.
 *
 * Requires `create` on `serviceaccounts/token` for the named accounts; the chart grants
 * exactly that, per tier namespace, in templates/tier-identities.yaml.
 */

const SA_TOKEN_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/token';
const SA_CA_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt';

/** How long to ask the API server to make each minted token valid for. */
const TOKEN_TTL_SECONDS = 3600;
/** Re-mint this long before expiry so a request never carries a token about to lapse. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

interface CachedToken {
  token: string;
  expiresAt: number;
}

const cache = new Map<string, CachedToken>();
/** In-flight mints, so a burst of concurrent requests triggers one API call, not many. */
const inflight = new Map<string, Promise<string>>();

/** `namespace/name` of a ServiceAccount, as configured per user. */
export type IdentityRef = string;

export function parseIdentityRef(ref: IdentityRef): { namespace: string; name: string } | null {
  const [namespace, name] = ref.split('/');
  if (!namespace || !name) return null;
  return { namespace, name };
}

/** The Kubernetes username the gateway will see for this ServiceAccount. */
export function identityUsername(ref: IdentityRef): string {
  const parsed = parseIdentityRef(ref);
  return parsed ? `system:serviceaccount:${parsed.namespace}:${parsed.name}` : ref;
}

/**
 * The built-in group every ServiceAccount in a namespace belongs to, which is what the
 * tier's MaaSSubscription owns. Derived rather than configured: the subscription and the
 * user list have to name the same group, and a silent mismatch there just makes the live
 * rate-limit display quietly stop updating.
 */
export function identityGroup(ref: IdentityRef): string | undefined {
  const parsed = parseIdentityRef(ref);
  return parsed ? `system:serviceaccounts:${parsed.namespace}` : undefined;
}

export function isInCluster(): boolean {
  return fs.existsSync(SA_TOKEN_PATH);
}

export async function getIdentityToken(ref: IdentityRef): Promise<string> {
  const cached = cache.get(ref);
  if (cached && cached.expiresAt - Date.now() > REFRESH_MARGIN_MS) {
    return cached.token;
  }

  const pending = inflight.get(ref);
  if (pending) return pending;

  const promise = mint(ref)
    .then(result => {
      cache.set(ref, result);
      return result.token;
    })
    .finally(() => {
      inflight.delete(ref);
    });

  inflight.set(ref, promise);
  return promise;
}

function mint(ref: IdentityRef): Promise<CachedToken> {
  const parsed = parseIdentityRef(ref);
  if (!parsed) return Promise.reject(new Error(`Malformed identity "${ref}", expected namespace/name`));

  const ownToken = fs.readFileSync(SA_TOKEN_PATH, 'utf8').trim();
  const body = JSON.stringify({
    apiVersion: 'authentication.k8s.io/v1',
    kind: 'TokenRequest',
    spec: { expirationSeconds: TOKEN_TTL_SECONDS },
  });
  const path = `/api/v1/namespaces/${parsed.namespace}/serviceaccounts/${parsed.name}/token`;

  return new Promise((resolve, reject) => {
    const caOpts: { ca?: Buffer } = {};
    if (fs.existsSync(SA_CA_PATH)) {
      caOpts.ca = fs.readFileSync(SA_CA_PATH);
    }

    const req = https.request(`https://kubernetes.default.svc${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ownToken}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      ...caOpts,
      rejectUnauthorized: true,
    }, res => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => {
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`TokenRequest for ${ref} failed: ${res.statusCode} ${data}`));
          return;
        }
        try {
          const parsedBody = JSON.parse(data) as { status?: { token?: string; expirationTimestamp?: string } };
          const token = parsedBody.status?.token;
          if (!token) {
            reject(new Error(`TokenRequest for ${ref} returned no token`));
            return;
          }
          const expiresAt = parsedBody.status?.expirationTimestamp
            ? Date.parse(parsedBody.status.expirationTimestamp)
            : Date.now() + TOKEN_TTL_SECONDS * 1000;
          resolve({ token, expiresAt });
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}
