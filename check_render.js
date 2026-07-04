const https = require('https');

const apiKey = 'rnd_yl7NyvvIfeGAq2sezXDiQeakqZqM';
const serviceId = 'srv-d94k4umq1p3s73bs322g';

const options = {
  hostname: 'api.render.com',
  port: 443,
  path: `/v1/services/${serviceId}/deploys?limit=5`,
  method: 'GET',
  headers: {
    'Authorization': `Bearer ${apiKey}`,
    'Accept': 'application/json',
    'User-Agent': 'Antigravity'
  }
};

console.log('Checking Render deployment status...');
const req = https.request(options, (res) => {
  let body = '';
  res.on('data', (chunk) => body += chunk);
  res.on('end', () => {
    console.log('Status Code:', res.statusCode);
    try {
      const data = JSON.parse(body);
      console.log('Deploys:', JSON.stringify(data, null, 2));
    } catch (e) {
      console.log('Raw Response:', body);
    }
  });
});

req.on('error', (e) => {
  console.error('Error:', e);
});

req.end();
