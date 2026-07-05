const https = require('https');

const videoUrl = 'https://www.youtube.com/watch?v=IEnCPUOl2UM';
const targetUrl = 'https://api.cobalt.liubquanti.click/';

console.log(`Sending POST to ${targetUrl}...`);

const parsed = new URL(targetUrl);
const data = JSON.stringify({
  url: videoUrl,
  downloadMode: 'auto',
  videoQuality: '1080'
});

const options = {
  hostname: parsed.hostname,
  port: 443,
  path: '/',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Content-Length': data.length
  }
};

const req = https.request(options, (res) => {
  let body = '';
  res.on('data', chunk => body += chunk);
  res.on('end', () => {
    console.log(`Status Code:`, res.statusCode);
    console.log('Headers:', res.headers);
    try {
      const parsedBody = JSON.parse(body);
      console.log('Response Body:', parsedBody);
      if ((res.statusCode === 200 || res.statusCode === 201) && parsedBody.url) {
        console.log(`SUCCESS! Direct download URL: ${parsedBody.url}`);
      }
    } catch (e) {
      console.log('Raw body (failed to parse JSON):', body);
    }
  });
});

req.on('error', (err) => {
  console.error(`Request error:`, err.message);
});

req.write(data);
req.end();
