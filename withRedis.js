// server.js
const express = require('express');
// const puppeteer = require('puppeteer');

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

const redis = require('redis');
const app = express();
const port = process.env.PORT || 3000;

// Create Redis client
const redisClient = redis.createClient({
  url: process.env.REDIS_URL || 'redis://localhost:6379'
});

// Redis methods
const getAsync = redisClient.get.bind(redisClient);
const setAsync = redisClient.set.bind(redisClient);

// Puppeteer setup
console.log('Initializing Puppeteer with Stealth Plugin...');
puppeteer.use(StealthPlugin());

// Middleware to parse JSON
app.use(express.json());

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

// Preview endpoint
app.post('/preview', async (req, res) => {
  const { url } = req.body;
  debugger;
  console.log('Received /preview request for URL:', url);
  
  if (!url) {
    console.error('URL is missing in request');
    return res.status(400).json({ error: 'URL is required' });
  }

  // Ensure URL has a protocol (http:// or https://)
  let urlWithProtocol = url;
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    urlWithProtocol = 'https://' + url;
    console.log('Added https:// to URL:', urlWithProtocol);
  }

  // Validate and normalize URL
  let normalizedUrl;
  try {
    normalizedUrl = new URL(urlWithProtocol).href;
  } catch (error) {
    console.error('Invalid URL provided:', urlWithProtocol, error);
    return res.status(400).json({ error: 'Invalid URL provided' });
  }

  // Check Redis cache first
  const cacheKey = `preview:${Buffer.from(normalizedUrl).toString('base64')}`;
  const cachedData = await getAsync(cacheKey);
  if (cachedData) {
    console.log('Cache found for URL:', normalizedUrl);
    // reset cache expiration
    await resetCacheTTL(cacheKey);
    return res.json(JSON.parse(cachedData));
  }
  console.log('Cache miss for URL:', normalizedUrl);
  // If not cached, generate preview
  console.log('Generating preview for URL:', normalizedUrl);
  try {
    const previewData = await generatePreview(normalizedUrl);
    console.log('Preview data generated successfully for URL:', normalizedUrl);
    // store preview data in Redis cache
    const cacheKey = `preview:${Buffer.from(normalizedUrl).toString('base64')}`;
    await storeCache(cacheKey, previewData);
    console.log('Preview data cached with key:', cacheKey);
    res.json(previewData);
  } catch (error) {
    console.error('Failed to generate preview for URL:', normalizedUrl, 'Error:', error.message);
    res.status(500).json({ 
      error: 'Failed to generate preview', 
      details: error.message,
      type: error.type || 'UNKNOWN_ERROR'
    });
  }
});

// Previews endpoint
app.post('/previews', async (req, res) => {
  const { urls } = req.body;
  console.log('Received /previews request for URLs:', urls);
  if (!urls) {
    console.error('URLs are missing in request');
    return res.status(400).json({ error: 'URLs are required' });
  }
  const urlArray = Array.isArray(urls) ? urls : [urls];
  const previews = [];
  if( urlArray.length === 0) {
    console.warn('No URLs provided for preview generation');
    return res.status(400).json({ error: 'No URLs provided for preview generation' });
  }
  if( urlArray.length > 10) {
    console.warn('Too many URLs provided for preview generation, limiting to 10');
    return res.status(400).json({ error: 'Too many URLs provided for preview generation, limit is 10' });
  }
  for (const url of urlArray) {
    console.log('Processing URL for preview:', url);
    if (!url) {
      console.warn('Skipping empty URL');
      continue; 
    }
    // Ensure URL has a protocol (http:// or https://)
    let urlWithProtocol = url;
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      urlWithProtocol = 'https://' + url;
      console.log('Added https:// to URL:', urlWithProtocol);
    }
    // Validate and normalize URL
    let normalizedUrl;
    try {
      normalizedUrl = new URL(urlWithProtocol).href;
    } catch (error) {
      console.error('Invalid URL provided:', urlWithProtocol, error);
      previews.push({ url: urlWithProtocol, error: 'Invalid URL provided' });
      continue; // Skip to next URL
    }
    // Check Redis cache first
    const cacheKey = `preview:${Buffer.from(normalizedUrl).toString('base64')}`;
    const cachedData = await getAsync(cacheKey);
    if (cachedData) {
      console.log('Cache found for URL:', normalizedUrl);
      previews.push({ url: normalizedUrl, fromCache: true, data: JSON.parse(cachedData) });
      // Reset cache expiration
      await resetCacheTTL(cacheKey);
      continue; // Skip to next URL
    }
    console.log('Cache miss for URL:', normalizedUrl);
    // If not cached, generate preview
    console.log('Generating preview for URL:', normalizedUrl);
    try {
      const previewData = await generatePreview(normalizedUrl);
      console.log('Preview data generated successfully for URL:', normalizedUrl);
      // Store preview data in Redis cache
      await storeCache(cacheKey, previewData);
      console.log('Preview data cached with key:', cacheKey);
      previews.push({ url: normalizedUrl, data: previewData });
    } catch (error) { 
      console.error('Failed to generate preview for URL:', normalizedUrl, 'Error:', error.message);
      previews.push({ url: normalizedUrl, error: 'Failed to generate preview', details: error.message, type: error.type || 'UNKNOWN_ERROR' });
    }
  }
  res.json(previews);
});

async function storeCache(cacheKey, previewData) {
  await setAsync(cacheKey, JSON.stringify(previewData), {
    EX: process.env.REDIS_EXPIRE || 86400
  });
};

async function resetCacheTTL(cacheKey, ttlSeconds = process.env.REDIS_EXPIRE || 86400) {
  const exists = await redisClient.exists(cacheKey);
  if (exists) {
    await redisClient.expire(cacheKey, ttlSeconds);
  } else {
    console.warn(`Key "${cacheKey}" does not exist. TTL not reset.`);
  }
}


// Log all requests
app.use((req, res, next) => {
  console.log(`${req.method} ${req.url} - Body:`, req.body);
  next();
});
// Log all responses
app.use((req, res, next) => {
  const oldSend = res.send;
  res.send = function (data) {  
    console.log(`Response for ${req.method} ${req.url}:`, data);
    oldSend.apply(res, arguments);
  };
  next();
});



// Clear cache for specific URL
app.delete('/cache', async (req, res) => {
 const { url } = req.body;
 if (!url) return res.status(400).json({ error: 'URL is required' });
 
 const cacheKey = `preview:${Buffer.from(url).toString('base64')}`;
 await redisClient.del(cacheKey);
 res.json({ status: 'cache cleared' });
});

// Get cache statistics
app.get('/cache-stats', async (req, res) => {
 const info = await redisClient.info();
 res.type('text').send(info);
});

// Get All Cache Keys and Values
app.get('/cache-keys', async (req, res) => {
  try {
    const keys = await redisClient.keys('preview:*');
    if (keys.length === 0) {
      return res.json({ message: 'No cache keys found' });
    }
    const values = await Promise.all(keys.map(key => getAsync(key)));
    const cacheEntries = keys.map((key, index) => ({
      key,
      value: JSON.parse(values[index])
    }));
    res.json(cacheEntries);
  } catch (error) {
    console.error('Error fetching cache keys:', error);
    res.status(500).json({ error: 'Failed to fetch cache keys', details: error.message });
  }
});


// Enhanced Puppeteer preview generator with robust navigation handling
async function generatePreview(targetUrl) {
  let browser;
  console.log('Launching Puppeteer for URL:', targetUrl);
  
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--ignore-certificate-errors',
        '--ignore-certificate-errors-spki-list'
      ],
      timeout: 20000  // Increased browser launch timeout
    });
    console.log('Puppeteer launched successfully.');
    
    const page = await browser.newPage();
    console.log('New page created. Setting user agent...');
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/94.0.4606.81 Safari/537.36');
    

    // Randomize viewport slightly to avoid fingerprinting from consistent dimensions
    await page.setViewport({
      width: Math.floor(1024 + Math.random() * 100),
      height: Math.floor(768 + Math.random() * 100),
    });
    
    // Set up navigation with retries
    const maxAttempts = 3;
    let attempt = 0;
    let lastError;
    
    while (attempt < maxAttempts) {
      try {
        console.log(`Navigating to target URL (attempt ${attempt+1} of ${maxAttempts}):`, targetUrl);
        await page.goto(targetUrl, { 
          waitUntil: 'domcontentloaded',
          timeout: 30000, // 30 seconds timeout per attempt
          referer: 'https://www.google.com/'
        });

        // Wait for the body to have some content (or use a more specific selector)
        await page.waitForSelector('body', { timeout: 10000 });
        await page.waitForFunction(() => document.body && document.body.innerText.length > 20, { timeout: 10000 });
        console.log('Navigation complete.');
        break;
      } catch (error) {
        attempt++;
        lastError = error;
        console.log(`Navigation attempt ${attempt} failed:`, error.message);
        if (attempt < maxAttempts) {
          console.log(`Retrying in 2 seconds...`);
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }
    }
    
    if (attempt === maxAttempts) {
      const err = new Error(`Navigation failed after ${maxAttempts} attempts: ${lastError.message}`);
      err.type = 'NAVIGATION_FAILED';
      throw err;
    }

    // Extract metadata
    console.log('Extracting metadata...');
    const previewData = await page.evaluate(() => {
      const getMetaContent = (name) => {
        const element = document.querySelector(`meta[name="${name}"], meta[property="${name}"]`);
        return element ? element.content : null;
      };

      return {
        title: getMetaContent('og:title') || document.title || null,
        siteName:
          getMetaContent('og:site_name') || getMetaContent('application-name') ||
          getMetaContent('al:android:app_name') || getMetaContent('al:ios:app_name') ||
          getMetaContent('twitter:app:name:iphone') ||getMetaContent('twitter:app:name:ipad') ||
          getMetaContent('twitter:app:name:googleplay') || (window.location.hostname ? window.location.hostname.replace(/^www\./, '') : null) ||
          null,
        description:
          getMetaContent('description') || getMetaContent('og:description') ||
          getMetaContent('twitter:description') || getMetaContent('dc.description') ||
          getMetaContent('Description') || null,
        url: window.location.href,
        icon: (
          document.querySelector('link[rel="icon"]')?.href || document.querySelector('link[rel="shortcut icon"]')?.href ||
          document.querySelector('link[rel="apple-touch-icon"]')?.href || document.querySelector('link[rel="apple-touch-icon-precomposed"]')?.href ||
          null
        ),
        image:
          getMetaContent('og:image') ||
          getMetaContent('twitter:image') ||
          getMetaContent('image') ||
          getMetaContent('twitter:image:src') ||
          getMetaContent('og:image:url') ||
          getMetaContent('og:image:secure_url') || null,
          isScreenshot: false
      };
    });
    console.log('Metadata extracted:', JSON.stringify(previewData, null, 2));

    // Capture screenshot if no image found
    if (!previewData.image) {
      previewData.isScreenshot = true;
      console.log('No image found in metadata. Capturing screenshot...');
      previewData.image = `data:image/png;base64,${await page.screenshot({ 
        encoding: 'base64',
        fullPage: false,  // Faster capture
        // quality: 70       // Reduce quality for smaller size
      })}`;
      console.log('Screenshot captured and added as image.');
    } else {
      console.log('Using found image:', previewData.image);
    }

    return previewData;
  } catch (error) {
    // Add error type if not set
    if (!error.type) error.type = 'GENERATION_ERROR';
    console.error('Preview generation error:', error);
    throw error;
  } finally {
    if (browser) {
      console.log('Closing Puppeteer browser...');
      try {
        await browser.close();
        console.log('Puppeteer browser closed successfully.');
      } catch (closeError) {
        console.error('Error closing browser:', closeError.message);
      }
    }
  }
}

// Connect to Redis and start server
redisClient.connect().then(() => {
  console.log('Connected to Redis');
  app.listen(port, () => {
    console.log(`Server running on port ${port}`);
  });
}).catch(err => {
  console.error('Failed to connect to Redis:', err);
  process.exit(1);
});


// Handle Redis connection errors
redisClient.on('error', (err) => {
  console.error('Redis error:', err);
});

// Handle ready state
redisClient.on('ready', () => {
  console.log('Redis client is Ready to handle requests.');
});

// Handle end state
redisClient.on('end', () => {
  console.log('Redis client disconnected');
});

// Handle reconnected state
redisClient.on('reconnecting', () => {
  console.log('Redis client reconnecting...');
});
