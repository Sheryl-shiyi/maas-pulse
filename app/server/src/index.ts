import express from 'express';
import { createServer } from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { initWebSocket, broadcast, setClientMessageHandler, setClientConnectHandler, sendTo } from './ws.js';
import { initMaasClients } from './maas-client.js';
import { initPrometheus, startPolling, stopPolling } from './prometheus.js';
import { startTraffic, stopTraffic, isRunning } from './traffic.js';
import { initChargeback, getChargebackData, updateModelRate } from './chargeback.js';
import { startSubscriptionWatcher, getWatchedRateLimits } from './subscription-watcher.js';
import { initOidc, createOidcRouter } from './oidc.js';
import type { AppConfig, ClientEvent } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadConfig(): AppConfig {
  const maasGatewayUrl = process.env['MAAS_GATEWAY_URL'] || 'https://maas.apps.cluster.example.com';
  const prometheusUrl = process.env['PROMETHEUS_URL'] || '';
  const prometheusToken = process.env['PROMETHEUS_TOKEN'] || '';

  const userKeys = (process.env['USER_API_KEYS'] || '').split(',').filter(Boolean);
  const userNames = (process.env['USER_NAMES'] || 'admin,user1,user2,user3,user4,user5').split(',');
  const userDisplayNames = (process.env['USER_DISPLAY_NAMES'] || '').split(',');
  const userRateLimits = (process.env['USER_RATE_LIMITS'] || '').split(',');
  const userGroups = (process.env['USER_GROUPS'] || '').split(',');
  const users = userNames.map((name, i) => ({
    name: name.trim(),
    displayName: userDisplayNames[i]?.trim() || name.trim(),
    apiKey: userKeys[i]?.trim() || '',
    rateLimit: userRateLimits[i]?.trim() || '',
    group: userGroups[i]?.trim() || '',
  }));

  const modelNames = (process.env['MODEL_NAMES'] || '').split(',').filter(Boolean);
  const modelDisplayNames = (process.env['MODEL_DISPLAY_NAMES'] || '').split(',');
  const modelTypes = (process.env['MODEL_TYPES'] || '').split(',');
  const models = modelNames.map((name, i) => ({
    name: name.trim(),
    displayName: modelDisplayNames[i]?.trim() || name.trim(),
    type: (modelTypes[i]?.trim() === 'external' ? 'external' : 'internal') as 'internal' | 'external',
  }));

  if (prometheusUrl) {
    initPrometheus(prometheusUrl, prometheusToken);
  }

  initChargeback(models);

  if (users.some(u => u.apiKey)) {
    initMaasClients(maasGatewayUrl, users.filter(u => u.apiKey));
  }

  return { maasGatewayUrl, prometheusUrl, models, users };
}

const config = loadConfig();

const app = express();
app.set('trust proxy', true);
app.use(express.json());

app.get('/api/config', (_req, res) => {
  res.json({
    models: config.models,
    users: config.users.map(u => ({ name: u.name, displayName: u.displayName, rateLimit: u.rateLimit })),
    trafficRunning: isRunning(),
  });
});

app.post('/api/traffic/start', (req, res) => {
  if (isRunning()) {
    res.status(409).json({ error: 'Traffic already running' });
    return;
  }

  const { pattern = 'concurrent', usersEnabled, modelsEnabled, ratePerSecond = 1 } = req.body;
  startTraffic({
    pattern,
    usersEnabled: usersEnabled || config.users.filter(u => u.apiKey).map(u => u.name),
    modelsEnabled: modelsEnabled || config.models.map(m => m.name),
    ratePerSecond: Math.min(Math.max(ratePerSecond, 0.1), 10),
  });

  res.json({ status: 'started' });
});

app.post('/api/traffic/stop', (_req, res) => {
  stopTraffic();
  res.json({ status: 'stopped' });
});

app.get('/api/chargeback', async (req, res) => {
  const timeRange = String(req.query['range'] || 'all');
  const allowed = ['all', '1h', '6h', '24h', '7d'];
  if (!allowed.includes(timeRange)) {
    res.status(400).json({ error: `range must be one of: ${allowed.join(', ')}` });
    return;
  }
  const data = await getChargebackData(timeRange);
  res.json(data);
});

app.put('/api/chargeback/rates', (req, res) => {
  const { model, inputPer1M, outputPer1M } = req.body;
  if (!model || typeof inputPer1M !== 'number' || typeof outputPer1M !== 'number') {
    res.status(400).json({ error: 'model, inputPer1M, outputPer1M required' });
    return;
  }
  updateModelRate(model, inputPer1M, outputPer1M);
  res.json({ status: 'updated' });
});

app.use(createOidcRouter());

const clientDist = path.join(__dirname, '../../client/dist');
app.use(express.static(clientDist));
app.get(/^\/(?!api|ws).*/, (_req, res) => {
  res.sendFile(path.join(clientDist, 'index.html'));
});

const server = createServer(app);
initWebSocket(server);

setClientConnectHandler((ws) => {
  sendTo(ws, {
    type: 'config',
    models: config.models,
    users: config.users.map(u => ({ name: u.name, displayName: u.displayName, rateLimit: u.rateLimit })),
  });
  const watched = getWatchedRateLimits();
  for (const [user, rateLimits] of watched) {
    sendTo(ws, { type: 'rate_limit_update', user, rateLimits });
  }
});

setClientMessageHandler((event: ClientEvent) => {
  switch (event.type) {
    case 'start_traffic':
      if (!isRunning()) {
        startTraffic({
          pattern: event.pattern,
          usersEnabled: event.usersEnabled,
          modelsEnabled: event.modelsEnabled,
          ratePerSecond: Math.min(Math.max(event.ratePerSecond, 0.1), 10),
        });
      }
      break;
    case 'stop_traffic':
      stopTraffic();
      break;
  }
});

if (config.models.length > 0 && config.prometheusUrl) {
  startPolling(config.models);
}

initOidc();

const subscriptionNs = process.env['SUBSCRIPTION_NAMESPACE'] || 'models-as-a-service';
const watchUsers = config.users.filter(u => u.group).map(u => ({ name: u.name, group: u.group }));
if (watchUsers.length > 0) {
  startSubscriptionWatcher(watchUsers, subscriptionNs);
}

const port = parseInt(process.env['PORT'] || '3001');
server.listen(port, () => {
  console.log(`[server] listening on http://localhost:${port}`);
  console.log(`[server] models: ${config.models.map(m => m.name).join(', ') || '(none configured)'}`);
  console.log(`[server] users with keys: ${config.users.filter(u => u.apiKey).length}/${config.users.length}`);
});
