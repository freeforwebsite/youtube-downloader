const https = require('https');

const apiKey = 'rnd_yl7NyvvIfeGAq2sezXDiQeakqZqM';
const serviceId = 'srv-d94k4umq1p3s73bs322g';

const data = JSON.stringify({
  clearCache: 'do_not_clear'
});

const options = {
  hostname: 'api.render.com',
  port: 443,
  path: `/v1/services/${serviceId}/deploys`,
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${apiKey}`,
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'Content-Length': data.length,
    'User-Agent': 'Antigravity'
  }
};

console.log('Triggering manual deploy on Render...');
const req = https.request(options, (res) => {
  let body = '';
  res.on('data', (chunk) => body += chunk);
  res.on('end', () => {
    console.log('Status Code:', res.statusCode);
    try {
      const parsed = JSON.parse(body);
      console.log('Response:', JSON.stringify(parsed, null, 2));
    } catch (e) {
      console.log('Raw Response:', body);
    }
  });
});

req.on('error', (e) => {
  console.error('Request error:', e);
});

req.write(data);
req.end();
