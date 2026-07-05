const https = require('https');

const urls = [
  'https://api.cobalt.meowing.de/',
  'https://cobalt.meowing.de/api/',
  'https://cobalt.meowing.de/api/v1/',
  'https://api.cobalt.canine.tools/',
  'https://api.cobalt.liubquanti.click/'
];

function testUrl(index) {
  if (index >= urls.length) {
    console.log('All URL tests complete.');
    return;
  }
  
  const target = urls[index];
  console.log(`Testing GET ${target}...`);
  
  const parsed = new URL(target);
  const options = {
    hostname: parsed.hostname,
    port: 443,
    path: parsed.pathname,
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0'
    }
  };
  
  const req = https.request(options, (res) => {
    let body = '';
    res.on('data', chunk => body += chunk);
    res.on('end', () => {
      console.log(`Response for ${target} -> Status: ${res.statusCode}`);
      console.log('Headers:', res.headers);
      console.log('Body snippet:', body.slice(0, 300));
      testUrl(index + 1);
    });
  });
  
  req.on('error', (err) => {
    console.error(`Error for ${target}:`, err.message);
    testUrl(index + 1);
  });
  
  req.end();
}

testUrl(0);
