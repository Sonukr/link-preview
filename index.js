// server.js
const express = require('express');
const puppeteer = require('puppeteer');
const app = express();
const port = process.env.PORT || 3000;

console.log('Initializing Express app...');

// Middleware to parse JSON
app.use(express.json());
console.log('JSON middleware added.');

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error middleware triggered:', err.stack);
  res.status(500).json({ error: 'Internal server error', details: err.message });
});
console.log('Error handling middleware added.');

// Preview endpoint
app.post('/preview', async (req, res) => {
  const { url } = req.body;
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
    console.error('Invalid URL provided:', urlWithProtocol);
    return res.status(400).json({ error: 'Invalid URL provided' });
  }

  try {
    const previewData = await generatePreview(normalizedUrl);
    console.log('Preview data generated successfully for URL:', normalizedUrl);
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
console.log('POST /preview endpoint added.');

// Enhanced Puppeteer preview generator with robust navigation handling
async function generatePreview(targetUrl) {
  let browser;
  console.log('Launching Puppeteer for URL:', targetUrl);
  
  try {
    browser = await puppeteer.launch({
      headless: 'new',
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
        title: document.title || null,
        description: getMetaContent('description') || getMetaContent('og:description') || null,
        image: getMetaContent('og:image') || getMetaContent('twitter:image') || null,
        url: window.location.href,
        siteName: getMetaContent('og:site_name') || null,
        icon: document.querySelector('link[rel="icon"]')?.href || null
      };
    });
    console.log('Metadata extracted:', JSON.stringify(previewData, null, 2));

    // Capture screenshot if no image found
    if (!previewData.image) {
      console.log('No image found in metadata. Capturing screenshot...');
      previewData.image = `data:image/png;base64,${await page.screenshot({ 
        encoding: 'base64',
        fullPage: false,  // Faster capture
        quality: 70       // Reduce quality for smaller size
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

// Start server
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
  console.log('Test with:');
  console.log(`curl -X POST http://localhost:${port}/preview \\`);
  console.log(`  -H "Content-Type: application/json" \\`);
  console.log(`  -d '{"url": "https://example.com"}'`);
});