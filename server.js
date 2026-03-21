const express = require('express');
const nodemailer = require('nodemailer');
const cors = require('cors');
const { VertexAI } = require('@google-cloud/vertexai');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const { Storage } = require('@google-cloud/storage');
require('dotenv').config();
const mongoose = require('mongoose');

// Connect to MongoDB
const MONGO_URI = process.env.MONGO_URI;
mongoose.connect(MONGO_URI)
  .then(() => console.log('Connected to MongoDB via Mongoose'))
  .catch(err => console.error('MongoDB connection error:', err));

// Lead Schema & Model
const leadSchema = new mongoose.Schema({
  name: String,
  phone: String,
  email: String,
  requirement: String,
  project: String,
  message: String,
  timestamp: { type: Date, default: Date.now }
});
const Lead = mongoose.model('Lead', leadSchema);

const app = express();
app.use(express.json());
app.use(cors());
app.get('/', (req, res) => res.send('YUG AMC Backend is Live!'));

const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'yug_super_secret_key';
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const RAG_FILE = path.join(__dirname, 'rag_context.json');
const LEADS_FILE = path.join(__dirname, 'leads.json');

// Ensure directories and files exist
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);
if (!fs.existsSync(RAG_FILE)) fs.writeFileSync(RAG_FILE, JSON.stringify({}));
if (!fs.existsSync(LEADS_FILE)) fs.writeFileSync(LEADS_FILE, JSON.stringify([]));

// Initialize Google Cloud Storage
const storageClient = new Storage({
  projectId: process.env.GCP_PROJECT_ID || 'efvframework'
});
const bucketName = 'yugamc-documents';
const bucket = storageClient.bucket(bucketName);

// Initialize Vertex AI
const vertexAI = new VertexAI({
  project: process.env.GCP_PROJECT_ID || 'efvframework',
  location: process.env.GOOGLE_LOCATION || 'asia-south1'
});

const generativeModel = vertexAI.getGenerativeModel({
  model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
});

// Admin Auth Middleware
const authenticateAdmin = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Access denied' });

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) return res.status(403).json({ error: 'Invalid token' });
    req.admin = decoded;
    next();
  });
};

// Admin Login
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  // Hardcoded for demo/setup - in production use hashed passwords in DB
  const ADMIN_USER = process.env.ADMIN_USERNAME || 'admin';
  const ADMIN_PASS = process.env.ADMIN_PASSWORD || 'yug@1234';

  if (username === ADMIN_USER && password === ADMIN_PASS) {
    const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '24h' });
    return res.json({ token });
  }
  res.status(401).json({ error: 'Invalid credentials' });
});

// File Management for RAG
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage });

// Extract text from files
async function extractText(filePath, originalName) {
  const extension = path.extname(originalName).toLowerCase();
  const fileBuffer = fs.readFileSync(filePath);

  if (extension === '.pdf') {
    try {
        // Handle modern Mehmet Kozan pdf-parse (version 2.4.5+)
        const { PDFParse } = require('pdf-parse');
        const uint8 = new Uint8Array(fileBuffer);
        const extractor = new PDFParse(uint8);
        const data = await extractor.getText();
        return data.text || "";
    } catch (e) {
        console.error('PDF Parse Specific Error:', e);
        return "";
    }
  } else if (extension === '.txt' || extension === '.md' || extension === '.json') {
    return fileBuffer.toString('utf8');
  }
  return ""; 
}

// Upload and Index
app.post('/api/admin/upload', authenticateAdmin, upload.array('files'), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded.' });
    }

    console.log(`[RAG] Uploading ${req.files.length} files...`);
    const currentRag = JSON.parse(fs.readFileSync(RAG_FILE) || '{}');
    let indexedCount = 0;
    
    for (let file of req.files) {
      try {
        console.log(`[RAG] Processing: ${file.originalname}`);
        const text = await extractText(file.path, file.originalname);
        
        if (text && text.trim().length > 0) {
          // Upload file to Google Cloud Storage
          console.log(`[GCS] Uploading to Bucket: ${file.originalname}`);
          await bucket.upload(file.path, {
              destination: file.originalname
          });
            
          currentRag[file.originalname] = {
              name: file.originalname,
              size: file.size,
              content: text,
              path: file.path, 
              uploadedAt: new Date()
          };
          indexedCount++;
          console.log(`[RAG & GCS] Indexed successfully: ${file.originalname}`);
        } else {
          console.warn(`[RAG] Skipping ${file.originalname}: No text extracted.`);
        }
      } catch (fileError) {
        console.error(`[RAG / GCS] Error processing ${file.originalname}:`, fileError.message);
      }
    }
    
    if (indexedCount === 0) {
        return res.status(400).json({ error: 'Koi bhi file train nahi ho saki. Kripya PDF check karein.' });
    }

    fs.writeFileSync(RAG_FILE, JSON.stringify(currentRag, null, 2));
    res.json({ message: `${indexedCount} files Cloud Server par upload ho gayi aur training mil gayi!` });
  } catch (error) {
    console.error('[RAG] Fatal Upload Error:', error);
    res.status(500).json({ error: 'System error during indexing.', details: error.message });
  }
});

// Get Files List
app.get('/api/admin/files', authenticateAdmin, (req, res) => {
    const currentRag = JSON.parse(fs.readFileSync(RAG_FILE));
    const files = Object.values(currentRag).map(f => ({ name: f.name, size: f.size, uploadedAt: f.uploadedAt }));
    res.json({ files });
});

// Delete File
app.delete('/api/admin/files/:filename', authenticateAdmin, async (req, res) => {
    const { filename } = req.params;
    const currentRag = JSON.parse(fs.readFileSync(RAG_FILE));
    if (currentRag[filename]) {
        if (fs.existsSync(currentRag[filename].path)) fs.unlinkSync(currentRag[filename].path);
        
        try {
            await bucket.file(filename).delete();
            console.log(`[GCS] Deleted ${filename} from bucket`);
        } catch (e) {
            console.warn(`[GCS] Could not delete ${filename} from bucket (might not exist)`);
        }

        delete currentRag[filename];
        fs.writeFileSync(RAG_FILE, JSON.stringify(currentRag, null, 2));
        return res.json({ message: 'File deleted' });
    }
    res.status(404).json({ error: 'File not found' });
});

// Enquiries Management for Admin
app.get('/api/admin/enquiries', authenticateAdmin, async (req, res) => {
    try {
        const dbLeads = await Lead.find().sort({ timestamp: -1 });
        const leads = dbLeads.map(l => ({
            id: l._id.toString(),
            name: l.name,
            phone: l.phone,
            email: l.email,
            requirement: l.requirement,
            project: l.project,
            message: l.message,
            timestamp: l.timestamp
        }));
        res.json({ leads });
    } catch (e) {
        console.error('Error fetching leads from DB:', e);
        res.status(500).json({ error: 'Error reading leads' });
    }
});

app.delete('/api/admin/enquiries/:id', authenticateAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        await Lead.findByIdAndDelete(id);
        res.json({ message: 'Lead deleted' });
    } catch (e) {
        console.error('Error deleting lead from DB:', e);
        res.status(500).json({ error: 'Delete failed' });
    }
});

// Enhanced Chatbot with RAG
app.post('/api/chat', async (req, res) => {
  const { message, history } = req.body;
  if (!message) return res.status(400).json({ error: 'Message is required' });

  try {
    // Get RAG Context
    const currentRag = JSON.parse(fs.readFileSync(RAG_FILE));
    const contextLines = Object.values(currentRag).map(f => f.content).join("\n\n---\n\n");

    const systemPrompt = `You are a premium luxury real estate AI assistant for YUG AMC.

Follow these STRICT formatting rules in every response:

1. Always respond in bullet points using the symbol "•".
2. Each bullet point MUST start on a NEW LINE.
3. NEVER combine multiple points in one line.
4. Add a single line break after every bullet point.
5. Highlight important names, projects, locations, and key terms using ONLY HTML <b> tags.
6. DO NOT use markdown symbols like **, ##, *, or _.
7. Keep each point short (1–2 lines maximum).
8. Maintain a clean, premium, concierge-style tone.
9. Do NOT write long paragraphs.
10. Ensure the response is visually structured and easy to read.

Example format:

• <b>Yash Heights</b> – A premium luxury residential project in South Civil Lines.

• <b>City Plaza</b> – An upcoming commercial hub located at Rampur Chowk.

• <b>SG Square</b> – A modern commercial and lifestyle destination in Vijay Nagar.

Always follow this format strictly.

    CRITICAL CONTEXT (Use this info to answer questions):
    ${contextLines}
    
    GENERAL COMPANY INFO (If not covered above):
    - Location: Jabalpur (Office at SG Square, Rampur Chowk).
    - Main Projects: 
      • <b>Yash Heights</b>: Luxury residential in South Civil Lines.
      • <b>City Plaza</b>: Upcoming commercial hub at Rampur Chowk.
      • <b>SG Square</b>: Premium commercial/lifestyle hub in Vijay Nagar.
    - Contact: 9752326763, 8871190020. Email: yugamcteam@gmail.com.
    
    Goal: Helping users find luxury properties, book site visits (free pickup/drop), and understand investment ROI.
    Always encourage users to book a site visit for direct experience.`;

    const chat = generativeModel.startChat({
      history: history || [],
      systemInstruction: systemPrompt
    });
    
    const result = await chat.sendMessage(message);
    const responseText = result.response.candidates[0].content.parts[0].text;
    
    res.json({ response: responseText });
  } catch (error) {
    console.error('Chat error:', error);
    res.status(500).json({ error: 'Assistant error', details: error.message });
  }
});

// Contact form endpoint
app.post('/api/contact', async (req, res) => {
  const { name, phone, email, requirement, project, message } = req.body;

  if (!name || !phone || !email || !requirement) {
    return res.status(400).json({ success: false, message: 'Please fill in all required fields.' });
  }

  try {
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: Number(process.env.SMTP_PORT) || 587,
      secure: Number(process.env.SMTP_PORT) === 465,
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
      tls: {
        rejectUnauthorized: false
      }
    });

    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: process.env.EMAIL_USER,
      replyTo: email,
      subject: `New Lead: ${requirement} - ${project || 'General Inquiry'}`,
      html: `
        <h2>New Contact Source: YUG AMC Website</h2>
        <p><strong>Name:</strong> ${name}</p>
        <p><strong>Phone:</strong> ${phone}</p>
        <p><strong>Email:</strong> ${email}</p>
        <p><strong>Requirement:</strong> ${requirement}</p>
        <p><strong>Preferred Project:</strong> ${project || 'N/A'}</p>
        <p><strong>Message:</strong> ${message || 'N/A'}</p>
      `,
    };

    await transporter.sendMail(mailOptions);
    
    // Save to MongoDB
    try {
        const leadEntry = new Lead({
            name, phone, email, requirement, project, message
        });
        await leadEntry.save();
        console.log('Lead saved to MongoDB:', leadEntry._id);
    } catch (e) {
        console.error('Error saving lead to MongoDB:', e);
    }

    res.status(200).json({ success: true, message: 'Message sent successfully.' });
  } catch (error) {
    console.error('Error sending email:', error);
    res.status(500).json({ success: false, message: 'Failed to send message.' });
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
