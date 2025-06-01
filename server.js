const express = require('express');
const fs = require('fs');
const { google } = require('googleapis');
const bodyParser = require('body-parser');
const open = require('open');

const app = express();
const PORT = process.env.PORT || 3000;

const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];
const TOKEN_PATH = 'token.json';
const CREDENTIALS_PATH = 'credentials.json';

app.use(bodyParser.json());
app.use(express.static('public'));

let payments = [];
let submissions = [];

function loadCredentials() {
  return new Promise((resolve, reject) => {
    fs.readFile(CREDENTIALS_PATH, (err, content) => {
      if (err) reject('Error loading credentials.json');
      else resolve(JSON.parse(content));
    });
  });
}

async function authorize() {
  const credentials = await loadCredentials();
  const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

  try {
    const token = fs.readFileSync(TOKEN_PATH);
    oAuth2Client.setCredentials(JSON.parse(token));
    return oAuth2Client;
  } catch {
    return getNewToken(oAuth2Client);
  }
}

function getNewToken(oAuth2Client) {
  return new Promise((resolve, reject) => {
    const authUrl = oAuth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: SCOPES,
    });
    console.log('\n🔑 Go to this URL and authorize the app:\n' + authUrl);
    open(authUrl);

    const readline = require('readline').createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    readline.question('\nPaste the code from Google here: ', (code) => {
      readline.close();
      oAuth2Client.getToken(code, (err, token) => {
        if (err) return reject('Failed to retrieve token');
        oAuth2Client.setCredentials(token);
        fs.writeFileSync(TOKEN_PATH, JSON.stringify(token));
        resolve(oAuth2Client);
      });
    });
  });
}

async function listMessages(auth) {
  const gmail = google.gmail({ version: 'v1', auth });
  const res = await gmail.users.messages.list({
    userId: 'me',
    maxResults: 30,
    q: 'subject:payment OR transaction OR upi OR credited OR received',
  });
  return res.data.messages || [];
}

async function getMessage(auth, messageId) {
  const gmail = google.gmail({ version: 'v1', auth });
  const res = await gmail.users.messages.get({
    userId: 'me',
    id: messageId,
  });
  return res.data;
}

async function scanPayments(oAuth2Client) {
  const messages = await listMessages(oAuth2Client);
  for (let msg of messages) {
    const msgData = await getMessage(oAuth2Client, msg.id);
    const snippet = msgData.snippet.toLowerCase();

    if (
      (snippet.includes('paid') || snippet.includes('credited') || snippet.includes('received')) &&
      (snippet.includes('upi') || snippet.includes('card') || snippet.includes('transaction'))
    ) {
      if (!payments.find(p => p.id === msg.id)) {
        payments.push({
          id: msg.id,
          snippet: msgData.snippet,
          date: new Date(parseInt(msgData.internalDate)),
        });
      }
    }
  }
}

function isPaymentVerified(email, txnId) {
  return payments.some(p =>
    (txnId && p.snippet.includes(txnId.toLowerCase())) ||
    (email && p.snippet.includes(email.toLowerCase()))
  );
}

let authClient = null;
app.get('/api/scan-payments', async (req, res) => {
  try {
    if (!authClient) authClient = await authorize();
    await scanPayments(authClient);
    res.json({ success: true, payments });
  } catch (err) {
    res.status(500).json({ error: err.toString() });
  }
});

app.post('/api/submit', (req, res) => {
  const { name, email, txnId } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'Name and Email required' });

  if (!isPaymentVerified(email, txnId)) {
    return res.status(400).json({ error: 'Payment not detected. Please wait or try again later.' });
  }

  submissions.push({ name, email, txnId, date: new Date() });
  res.json({ success: true, message: 'Payment verified. Form submitted!' });
});

app.get('/api/admin-data', (req, res) => {
  res.json({ payments, submissions });
});

app.listen(PORT, () => {
  console.log(`✅ Server is running on port ${PORT}`);
});