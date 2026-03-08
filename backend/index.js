/**
 * NIRBHAYA AI — Backend Server v3
 * ════════════════════════════════════════════════════════════════════════════
 * Endpoints:
 *   GET  /health                 → server health check
 *   POST /send-sms               → send real SMS via AWS SNS to trusted contacts
 *   POST /alert                  → store alert in DynamoDB
 *   GET  /alerts/:userId         → fetch alert history
 *   GET  /contacts/:userId       → fetch trusted contacts
 *   POST /contacts/:userId       → save trusted contact
 *   GET  /location/risk          → get risk score for GPS coordinate
 *   POST /evidence/upload-url    → get pre-signed S3 URL for evidence upload
 *
 * ── Environment Variables ────────────────────────────────────────────────────
 *   PORT                    – server port (default: 3001)
 *   AWS_REGION              – e.g. ap-south-1  (REQUIRED for real SMS)
 *   AWS_ACCESS_KEY_ID       – IAM key  (or use IAM role on EC2/Lambda)
 *   AWS_SECRET_ACCESS_KEY   – IAM secret
 *   DYNAMODB_TABLE_ALERTS   – e.g. nirbhaya-alerts
 *   DYNAMODB_TABLE_CONTACTS – e.g. nirbhaya-contacts
 *   SNS_TOPIC_ARN           – SNS topic for fan-out push alerts
 *   S3_EVIDENCE_BUCKET      – S3 bucket for encrypted evidence
 *
 * ── Quick Start (local dev) ──────────────────────────────────────────────────
 *   npm install
 *   cp .env.example .env   # fill in AWS credentials
 *   node index.js
 *
 * ── Deploy to AWS ────────────────────────────────────────────────────────────
 *   Option A: Run on EC2 with pm2: pm2 start index.js --name nirbhaya-backend
 *   Option B: Wrap in Lambda + API Gateway (export handler)
 *   Option C: Deploy on Railway / Render / Fly.io (free tier friendly)
 */

require('dotenv').config();

const express        = require('express');
const cors           = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '1mb' }));

// ── AWS SDK ───────────────────────────────────────────────────────────────────
let snsClient    = null;
let dynamoClient = null;
let s3Client     = null;
let SNSPublish, DynamoPut, DynamoQuery, DynamoGet;

async function initAWS() {
  if (!process.env.AWS_REGION) {
    console.log('⚠️  [AWS] AWS_REGION not set — running in DEMO mode');
    console.log('    Set AWS_REGION + credentials in .env to enable real SMS');
    return;
  }

  try {
    const { SNSClient, PublishCommand }  = await import('@aws-sdk/client-sns');
    const { DynamoDBClient }             = await import('@aws-sdk/client-dynamodb');
    const { DynamoDBDocumentClient,
            PutCommand, QueryCommand,
            GetCommand }                 = await import('@aws-sdk/lib-dynamodb');
    const { S3Client, PutObjectCommand,
            GetObjectCommand }           = await import('@aws-sdk/client-s3');
    const { getSignedUrl }               = await import('@aws-sdk/s3-request-presigner');

    const cfg = { region: process.env.AWS_REGION };

    snsClient = new SNSClient(cfg);
    s3Client  = new S3Client(cfg);

    const base   = new DynamoDBClient(cfg);
    dynamoClient = DynamoDBDocumentClient.from(base, {
      marshallOptions: { removeUndefinedValues: true },
    });

    SNSPublish  = PublishCommand;
    DynamoPut   = PutCommand;
    DynamoQuery = QueryCommand;
    DynamoGet   = GetCommand;

    // Test SNS connection
    console.log(`✅ [AWS] SDK initialised — region: ${process.env.AWS_REGION}`);
    console.log('📱 [SMS] Real AWS SNS SMS is ENABLED');
  } catch (err) {
    console.error('❌ [AWS] SDK init failed:', err.message);
    console.log('   Running in DEMO mode — SMS will be logged, not sent');
  }
}

// ── In-memory stores (demo mode fallback) ─────────────────────────────────────
const memAlerts   = [];
const memContacts = {};

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Normalise phone to E.164 format (+91XXXXXXXXXX for India).
 */
function normalisePhone(raw) {
  const digits = raw.replace(/[\s\-()]/g, '');
  if (digits.startsWith('+'))    return digits;
  if (/^\d{10}$/.test(digits))   return '+91' + digits;
  if (digits.startsWith('0'))    return '+91' + digits.slice(1);
  if (digits.startsWith('91') && digits.length === 12) return '+' + digits;
  return '+91' + digits;
}

function now() { return new Date().toISOString(); }

// ── GET /health ───────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status:    'ok',
    service:   'nirbhaya-ai',
    version:   '3.0.0',
    aws_mode:  !!snsClient,
    region:    process.env.AWS_REGION || 'demo',
    timestamp: now(),
  });
});

// ── POST /send-sms ────────────────────────────────────────────────────────────
/**
 * Sends a real SMS to each trusted contact via AWS SNS direct publish.
 *
 * Body:
 *   phoneNumbers  string[]  – E.164 or local 10-digit numbers
 *   message       string    – SMS body (max 1600 chars)
 *   alertLevel    string    – LOW | MEDIUM | HIGH | CRITICAL | TEST
 *   score         number    – threat score 0–100
 *   location      string    – human-readable address
 *   mapsLink      string    – Google Maps URL (optional)
 *
 * AWS requirements:
 *   1. IAM role/user must have: sns:Publish permission
 *   2. For India (+91): SNS account must be out of SMS sandbox
 *      → Go to AWS console → SNS → Text messaging → Move out of sandbox
 *   3. Optionally set Sender ID: must be registered via AWS Support for India
 */
app.post('/send-sms', async (req, res) => {
  const { phoneNumbers, message, alertLevel = 'UNKNOWN', score = 0, location = '', mapsLink = '' } = req.body;

  // Validate
  if (!phoneNumbers || !Array.isArray(phoneNumbers) || phoneNumbers.length === 0) {
    return res.status(400).json({ error: 'phoneNumbers[] is required' });
  }
  if (!message || message.trim().length === 0) {
    return res.status(400).json({ error: 'message is required' });
  }

  const sanitised = phoneNumbers.map(normalisePhone);
  const results   = [];
  let   sent      = 0;

  console.log(`\n📱 [SMS] Sending ${alertLevel} alert to ${sanitised.length} recipient(s)`);
  console.log(`   Score: ${score} | Location: ${location}`);
  console.log(`   Numbers: ${sanitised.join(', ')}`);
  console.log(`   Message preview: ${message.slice(0, 80)}…`);

  if (snsClient) {
    // ── REAL SMS via AWS SNS ──────────────────────────────────────────────────
    for (const phone of sanitised) {
      try {
        const cmd = new SNSPublish({
          PhoneNumber: phone,
          Message:     message,
          MessageAttributes: {
            // Sender ID — up to 11 chars. Must be pre-registered for India.
            // Remove this attribute if you haven't registered.
            'AWS.SNS.SMS.SenderID': {
              DataType:    'String',
              StringValue: 'NRBHAYA',
            },
            // Transactional = highest delivery priority (emergency messages)
            'AWS.SNS.SMS.SMSType': {
              DataType:    'String',
              StringValue: 'Transactional',
            },
          },
        });

        const response = await snsClient.send(cmd);
        results.push({ phone, status: 'sent', messageId: response.MessageId });
        sent++;
        console.log(`   ✅ SMS sent to ${phone} — MessageId: ${response.MessageId}`);

      } catch (err) {
        // Common errors:
        // - InvalidParameter: phone sandbox restriction
        // - AuthorizationError: IAM permissions missing
        console.error(`   ❌ SMS failed for ${phone}: ${err.message}`);

        // Provide actionable error hints
        let hint = '';
        if (err.message.includes('sandbox')) {
          hint = 'Move SNS out of sandbox in AWS Console → SNS → Text messaging';
        } else if (err.message.includes('Unauthorized') || err.message.includes('AuthorizationError')) {
          hint = 'Add sns:Publish permission to your IAM role/user';
        } else if (err.message.includes('InvalidParameter')) {
          hint = 'Check phone number format — should be +91XXXXXXXXXX';
        }

        results.push({ phone, status: 'failed', error: err.message, hint });
      }
    }

  } else {
    // ── DEMO MODE — log to console, simulate success ──────────────────────────
    console.log('\n━━━━━━━━━━━ SMS DEMO (no AWS credentials) ━━━━━━━━━━━');
    console.log('Full message:\n' + message);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    sanitised.forEach(phone => {
      results.push({ phone, status: 'demo_sent' });
    });
    sent = sanitised.length;
  }

  return res.json({
    success:   sent > 0,
    sent,
    total:     sanitised.length,
    failed:    sanitised.length - sent,
    results,
    demo_mode: !snsClient,
    aws_note:  !snsClient
      ? 'Set AWS_REGION + credentials in .env to send real SMS'
      : undefined,
  });
});

// ── POST /alert ───────────────────────────────────────────────────────────────
app.post('/alert', async (req, res) => {
  const { userId = 'anonymous', threatScore, level, location, lat, lng, timestamp, factors } = req.body;

  if (!threatScore || !level) {
    return res.status(400).json({ error: 'threatScore and level are required' });
  }

  const alertId = `ALT-${uuidv4()}`;
  const alert   = {
    id:          alertId,
    userId,
    threatScore: Number(threatScore),
    level,
    location:    location || {},
    lat:         lat ? Number(lat) : undefined,
    lng:         lng ? Number(lng) : undefined,
    factors:     factors || {},
    timestamp:   timestamp || now(),
    resolved:    false,
    contacts_notified: 0,
  };

  try {
    if (dynamoClient && process.env.DYNAMODB_TABLE_ALERTS) {
      await dynamoClient.send(new DynamoPut({
        TableName: process.env.DYNAMODB_TABLE_ALERTS,
        Item:      alert,
      }));
      console.log(`[DB] Alert stored: ${alertId}`);
    } else {
      memAlerts.unshift(alert);
    }
    res.status(201).json({ success: true, alertId });
  } catch (err) {
    console.error('[POST /alert]', err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /alerts/:userId ───────────────────────────────────────────────────────
app.get('/alerts/:userId', async (req, res) => {
  const { userId } = req.params;
  try {
    if (dynamoClient && process.env.DYNAMODB_TABLE_ALERTS) {
      const r = await dynamoClient.send(new DynamoQuery({
        TableName:                 process.env.DYNAMODB_TABLE_ALERTS,
        IndexName:                 'userId-timestamp-index',
        KeyConditionExpression:    'userId = :uid',
        ExpressionAttributeValues: { ':uid': userId },
        ScanIndexForward:          false,
        Limit:                     50,
      }));
      return res.json(r.Items || []);
    }
    res.json(memAlerts.filter(a => a.userId === userId));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /contacts/:userId ─────────────────────────────────────────────────────
app.get('/contacts/:userId', async (req, res) => {
  const { userId } = req.params;
  try {
    if (dynamoClient && process.env.DYNAMODB_TABLE_CONTACTS) {
      const r = await dynamoClient.send(new DynamoQuery({
        TableName:                 process.env.DYNAMODB_TABLE_CONTACTS,
        KeyConditionExpression:    'userId = :uid',
        ExpressionAttributeValues: { ':uid': userId },
      }));
      return res.json(r.Items || []);
    }
    res.json(memContacts[userId] || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /contacts/:userId ────────────────────────────────────────────────────
app.post('/contacts/:userId', async (req, res) => {
  const { userId } = req.params;
  const contact    = {
    ...req.body,
    userId,
    id:        req.body.id || `C-${uuidv4()}`,
    createdAt: now(),
  };

  try {
    if (dynamoClient && process.env.DYNAMODB_TABLE_CONTACTS) {
      await dynamoClient.send(new DynamoPut({
        TableName: process.env.DYNAMODB_TABLE_CONTACTS,
        Item:      contact,
      }));
    } else {
      if (!memContacts[userId]) memContacts[userId] = [];
      memContacts[userId].push(contact);
    }
    res.status(201).json(contact);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /location/risk ────────────────────────────────────────────────────────
/**
 * Returns a risk score 0.0–1.0 for a GPS coordinate.
 * In production: query a DynamoDB geo-index with crime statistics data.
 */
app.get('/location/risk', (req, res) => {
  const { lat, lng } = req.query;
  if (!lat || !lng) return res.status(400).json({ error: 'lat and lng required' });

  const hour    = new Date().getHours();
  let   base    = 0.2;

  // Time-of-day risk
  if (hour >= 22 || hour < 5) base += 0.35;
  else if (hour >= 19)        base += 0.15;

  // Known high-risk demo zones
  const HIGH_RISK_ZONES = [
    [28.63, 28.64, 77.20, 77.21],   // Delhi CP
    [12.97, 12.98, 77.59, 77.60],   // Bangalore demo
    [19.04, 19.08, 72.82, 72.86],   // Mumbai Bandra
  ];
  const lt = parseFloat(lat), lg = parseFloat(lng);
  for (const [la1, la2, lo1, lo2] of HIGH_RISK_ZONES) {
    if (la1 <= lt && lt <= la2 && lo1 <= lg && lg <= lo2) {
      base += 0.35;
      break;
    }
  }

  res.json({ riskScore: Math.min(1, parseFloat(base.toFixed(2))), lat: lt, lng: lg });
});

// ── POST /evidence/upload-url ─────────────────────────────────────────────────
app.post('/evidence/upload-url', async (req, res) => {
  const { userId = 'unknown', fileType = 'audio/mp4' } = req.body;
  const extMap = { 'audio/mp4': 'mp4', 'audio/webm': 'webm', 'image/jpeg': 'jpg', 'image/png': 'png' };
  const ext    = extMap[fileType] || 'bin';
  const evId   = `EV-${uuidv4()}`;
  const key    = `evidence/${userId}/${new Date().toISOString().slice(0,10)}/${evId}.${ext}`;

  if (s3Client && process.env.S3_EVIDENCE_BUCKET) {
    try {
      const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
      const { PutObjectCommand } = await import('@aws-sdk/client-s3');
      const url = await getSignedUrl(s3Client, new PutObjectCommand({
        Bucket:               process.env.S3_EVIDENCE_BUCKET,
        Key:                  key,
        ContentType:          fileType,
        ServerSideEncryption: 'AES256',
      }), { expiresIn: 900 });
      return res.json({ url, evidenceId: evId, key });
    } catch (err) {
      console.error('[S3 presign]', err.message);
    }
  }

  res.json({ url: null, evidenceId: evId, demo: true, message: 'S3 not configured — evidence URL demo only' });
});

// ── Start ──────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;

initAWS().then(() => {
  app.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════════════════════╗
║              NIRBHAYA AI — Backend Server v3                 ║
╠══════════════════════════════════════════════════════════════╣
║  Local URL  : http://localhost:${PORT}                           ║
║  Health     : GET  /health                                   ║
║  SMS        : POST /send-sms   ← real SMS when AWS set       ║
║  Alerts     : POST /alert                                    ║
║  AWS mode   : ${process.env.AWS_REGION ? `LIVE (${process.env.AWS_REGION})                      ` : 'DEMO (set AWS_REGION in .env)          '}║
╚══════════════════════════════════════════════════════════════╝

  To enable real SMS:
  1. Set AWS_REGION=ap-south-1 in .env
  2. Set AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY
  3. Ensure IAM has sns:Publish permission
  4. Move SNS out of sandbox (AWS Console → SNS → Text messaging)
`);
  });
});

module.exports = app;
