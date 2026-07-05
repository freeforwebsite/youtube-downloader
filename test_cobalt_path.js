const https = require('https');

const videoUrl = 'https://www.youtube.com/watch?v=IEnCPUOl2UM';
const instances = [
  'https://cobalt.meowing.de',
  'https://cobalt.liubquanti.click',
  'https://cobalt.canine.tools',
  'https://cobalt.squair.xyz'
];

function tryInstance(index) {
  if (index >= instances.length) {
    console.error('All Cobalt instances failed.');
    return;
  }
  
  const baseUrl = instances[index];
  console.log(`Trying Cobalt instance: ${baseUrl}/api/json...`);
  
  const parsed = new URL(baseUrl);
  const data = JSON.stringify({
    url: videoUrl,
    vCodec: 'h264',
    vQuality: '1080',
    aFormat: 'mp3',
    isAudioOnly: false
  });
  
  const options = {
    hostname: parsed.hostname,
    port: 443,
    path: '/api/json',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      'Content-Length': data.length
    }
  };
  
  const req = https.request(options, (res) => {
    let body = '';
    res.on('data', chunk => body += chunk);
    res.on('end', () => {
      console.log(`Status Code for ${baseUrl}/api/json:`, res.statusCode);
      try {
        const parsedBody = JSON.parse(body);
        console.log('Response:', parsedBody);
        if ((res.statusCode === 200 || res.statusCode === 201) && parsedBody.url) {
          console.log(`SUCCESS! Direct download URL: ${parsedBody.url}`);
        } else {
          tryInstance(index + 1);
        }
      } catch (e) {
        console.log('Raw body (failed to parse JSON):', body);
        tryInstance(index + 1);
      }
    });
  });
  
  req.on('error', (err) => {
    console.error(`Request error for ${baseUrl}:`, err.message);
    tryInstance(index + 1);
  });
  
  req.write(data);
  req.end();
}

tryInstance(0);
