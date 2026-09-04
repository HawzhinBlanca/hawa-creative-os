import http from 'node:http';
export * from './workflow.js';

const port = Number(process.env.PORT || 9080);
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'healthy', worker: 'restate-worker-1', timestamp: new Date().toISOString() }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'ready', message: 'Hawa Restate Durable Workflow Worker' }));
});

server.listen(port, () => {
  console.log(`Hawa Worker listening on port ${port} for Restate durable invocations...`);
});

