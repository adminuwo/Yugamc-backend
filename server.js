const express = require('express');
const dns = require('dns');
try {
  dns.setServers(['8.8.8.8', '8.8.4.4']); 
} catch(e) { console.warn('DNS override failed, using default.'); }
if (dns.setDefaultResultOrder) dns.setDefaultResultOrder('ipv4first');


const nodemailer = require('nodemailer');
const cors = require('cors');
const { VertexAI } = require('@google-cloud/vertexai');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const { Storage } = require('@google-cloud/storage');
const mammoth = require('mammoth');
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

// Chat Lead Schema & Model
const chatLeadSchema = new mongoose.Schema({
  name: String,
  email: String,
  messages: [{ 
    role: String, 
    content: String, 
    timestamp: { type: Date, default: Date.now } 
  }],
  timestamp: { type: Date, default: Date.now }
});
const ChatLead = mongoose.model('ChatLead', chatLeadSchema);

// Book Visit Schema & Model
const bookVisitSchema = new mongoose.Schema({
  name: String,
  phone: String,
  email: String,
  location: String,
  budget: String,
  visitDate: String,
  timeSlot: String,
  timestamp: { type: Date, default: Date.now }
});
const BookVisit = mongoose.model('BookVisit', bookVisitSchema);

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

// Get Book Visit Leads (Admin Only)
app.get('/api/admin/book-visits', authenticateAdmin, async (req, res) => {
  try {
    const leads = await BookVisit.find().sort({ timestamp: -1 });
    res.json({ leads });
  } catch (err) {
    res.status(500).json({ message: 'Error fetching book visit leads' });
  }
});

// Delete Book Visit Lead (Admin Only)
app.delete('/api/admin/book-visits/:id', authenticateAdmin, async (req, res) => {
  try {
    await BookVisit.findByIdAndDelete(req.params.id);
    res.json({ message: 'Book visit lead deleted successfully' });
  } catch (err) {
    res.status(500).json({ message: 'Error deleting lead' });
  }
});

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
const upload = multer({ 
  storage,
  limits: { files: 1000 } // Allow up to 1000 files at once
});

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
  } else if (extension === '.docx') {
    try {
        const result = await mammoth.extractRawText({ buffer: fileBuffer });
        return result.value || "";
    } catch (e) {
        console.error('Docx Parse Error:', e);
        return "";
    }
  } else if (extension === '.txt' || extension === '.md' || extension === '.json') {
    return fileBuffer.toString('utf8');
  }
  return ""; 
}

// Upload and Index
app.post('/api/admin/upload', authenticateAdmin, upload.array('files', 1000), async (req, res) => {
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

// Chat Lead Management
app.post('/api/chat/register', async (req, res) => {
    const { name, email } = req.body;
    if (!name || !email) return res.status(400).json({ error: 'Name and Email are required' });

    try {
        const newLead = new ChatLead({ name, email, messages: [] });
        await newLead.save();

        // Send Email Notification to Admin
        const transporter = nodemailer.createTransport({
            host: process.env.SMTP_HOST || 'smtp.gmail.com',
            port: Number(process.env.SMTP_PORT) || 587,
            secure: Number(process.env.SMTP_PORT) === 465,
            auth: {
                user: process.env.EMAIL_USER,
                pass: process.env.EMAIL_PASS,
            },
            tls: { rejectUnauthorized: false }
        });

        const mailOptions = {
            from: process.env.EMAIL_USER,
            to: 'admin@uwo24.com', // As requested
            subject: `New User Registered - YUG AMC`,
            html: `
                <div style="font-family: sans-serif; padding: 20px; border: 1px solid #eee; border-radius: 10px;">
                    <h2 style="color: #6366f1;">New User Registration</h2>
                    <p>A new user has registered on the YUG AMC Assistant.</p>
                    <hr/>
                    <p><strong>Name:</strong> ${name}</p>
                    <p><strong>Email:</strong> ${email}</p>
                    <p><strong>Timestamp:</strong> ${new Date().toLocaleString()}</p>
                </div>
            `,
        };

        await transporter.sendMail(mailOptions);
        res.json({ success: true, leadId: newLead._id });
    } catch (error) {
        console.error('Registration error:', error);
        res.status(500).json({ error: 'Registration failed' });
    }
});

app.get('/api/admin/chat-leads', authenticateAdmin, async (req, res) => {
    try {
        const leads = await ChatLead.find().sort({ timestamp: -1 });
        res.json({ leads });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch chat leads' });
    }
});

app.get('/api/admin/chat-leads/:id', authenticateAdmin, async (req, res) => {
    try {
        const lead = await ChatLead.findById(req.params.id);
        if (!lead) return res.status(404).json({ error: 'Lead not found' });
        res.json({ lead });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch chat history' });
    }
});

app.get('/api/admin/chat-leads/export', authenticateAdmin, async (req, res) => {
    try {
        const leads = await ChatLead.find().sort({ timestamp: -1 });
        let csv = 'Name,Email,Registration Time,Message Count\n';
        leads.forEach(l => {
            csv += `"${l.name}","${l.email}","${l.timestamp.toISOString()}","${l.messages.length}"\n`;
        });
        res.header('Content-Type', 'text/csv');
        res.attachment('yug_amc_chat_leads.csv');
        res.send(csv);
    } catch (error) {
        res.status(500).json({ error: 'Export failed' });
    }
});

// Enhanced Chatbot with RAG
app.post('/api/chat', async (req, res) => {
  const { message, history, leadId } = req.body;
  if (!message) return res.status(400).json({ error: 'Message is required' });

  try {
    // If leadId is provided, save user message
    if (leadId) {
        await ChatLead.findByIdAndUpdate(leadId, {
            $push: { messages: { role: 'user', content: message } }
        });
    }

    // Get RAG Context
    const currentRag = JSON.parse(fs.readFileSync(RAG_FILE));
    const contextLines = Object.values(currentRag).map(f => f.content).join("\n\n---\n\n");

    const systemPrompt = `YOU ARE A PREMIUM AI ASSISTANT FOR YUG AMC. YOUR JOB IS TO GENERATE RESPONSES THAT FEEL ELEGANT, STRUCTURED, AND LIKE A PREMIUM CONCIERGE.

STRICT FORMAT RULES (MANDATORY):

1. INTRO: ALWAYS start with a short, engaging paragraph (2–3 lines). NO bullet points at the beginning.
2. MIXED CONTENT: Use a natural mix of short paragraphs, small sections, and EXTREMELY LIMITED bullet points.
3. BULLET RULES: 
   - Use the "•" symbol for bullets.
   - Maximum 3–4 bullets per section.
   - Maximum 1–2 bullet sections in total.
   - NEVER convert the full response into bullets.
4. HIGHLIGHTS: Use **bold text** for key elements like project names (**Yash Heights**, **City Plaza**, **SG Square**), locations, and key benefits.
5. TONE: Short, clean sentences with a premium "human concierge" tone. Avoid robotic list generation.
6. SPACING: Ensure proper line breaks and breathing space between sections.

STRUCTURE MUST LOOK LIKE THIS:
[Intro Paragraph - 2-3 lines]

[Short Paragraph OR Heading - e.g., ### Luxury Lifestyle]

• Detail 1
• Detail 2
(Max 3 bullets)

[Another short paragraph explaining value/context]

[Optional small bullet section or concluding thought]

[Closing CTA line]

❌ STRICTLY AVOID:
- Full bullet-only responses.
- Long boring paragraphs.
- Repetitive structure or robotic wording.
- Starting the first line with a bullet point.

🎯 ENDING RULE:
Always end with this exact soft CTA style: "Would you like to explore available options or book a site visit?"

REWRITE POLICY: Before outputting, verify if the response is mixed and visually clean. If it is mostly bullets, abandon the draft and write it as a conversational card.

CRITICAL CONTEXT:
${contextLines}

GENERAL COMPANY INFO:
- Jabalpur based. Office at SG Square, Rampur Chowk.
- Projects: **Yash Heights** (South Civil Lines), **City Plaza** (Rampur Chowk), **SG Square** (Vijay Nagar).
- Services: Premium property guidance, ROI analysis, and site visits (with complimentary pickup/drop).`;

    const chat = generativeModel.startChat({
      history: history || [],
      systemInstruction: systemPrompt
    });
    
    const result = await chat.sendMessage(message);
    const responseText = result.response.candidates[0].content.parts[0].text;
    
    // If leadId is provided, save model response
    if (leadId) {
        await ChatLead.findByIdAndUpdate(leadId, {
            $push: { messages: { role: 'model', content: responseText } }
        });
    }

    res.json({ response: responseText });
  } catch (error) {
    console.error('Chat error:', error);
    res.status(500).json({ error: 'Assistant error', details: error.message });
  }
});

// Contact form endpoint
app.post('/api/contact', async (req, res) => {
  const { name, phone, email, requirement, project, message } = req.body;
  console.log(`[POST /api/contact] Received lead from ${name} (${phone})`);

  if (!name || !phone || !email || !requirement) {
    return res.status(400).json({ success: false, message: 'Please fill in all required fields.' });
  }

  // 1. Save to MongoDB First (Priority)
  let leadId = null;
  try {
      const leadEntry = new Lead({ name, phone, email, requirement, project, message });
      const savedLead = await leadEntry.save();
      leadId = savedLead._id;
      console.log(`[DB SUCCESS] Lead saved with ID: ${leadId}`);
  } catch (dbError) {
      console.error('[DB ERROR] Failed to save lead:', dbError);
  }

  // 2. Send Email Notification
  try {
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: Number(process.env.SMTP_PORT) || 587,
      secure: Number(process.env.SMTP_PORT) === 465,
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
      tls: { rejectUnauthorized: false }
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
        ${leadId ? `<p><small>Database ID: ${leadId}</small></p>` : ''}
      `,
    };

    await transporter.sendMail(mailOptions);
    console.log('[EMAIL SUCCESS] Lead notification sent.');
  } catch (emailError) {
    console.error('[EMAIL ERROR] Failed to send email:', emailError.message);
  }

  if (leadId) {
    res.status(200).json({ success: true, message: 'Your inquiry has been received. We will call you back.' });
  } else {
    res.status(500).json({ success: false, message: 'System error. Please call us directly.' });
  }
});

// Book Visit endpoint
app.post('/api/book-visit', async (req, res) => {
  const { name, phone, email, location, budget, visitDate, timeSlot } = req.body;
  console.log(`[POST /api/book-visit] Received booking from ${name} (${phone})`);

  if (!name || !phone || !email || !visitDate) {
    return res.status(400).json({ success: false, message: 'Required fields missing.' });
  }

  // 1. Save to MongoDB
  let bookingId = null;
  try {
    const bookingEntry = new BookVisit({ name, phone, email, location, budget, visitDate, timeSlot });
    const savedBooking = await bookingEntry.save();
    bookingId = savedBooking._id;
    console.log(`[DB SUCCESS] Booking saved with ID: ${bookingId}`);
  } catch (dbError) {
    console.error('[DB ERROR] Failed to save booking:', dbError);
  }

  // 2. Send Email Notification
  try {
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: Number(process.env.SMTP_PORT) || 587,
      secure: Number(process.env.SMTP_PORT) === 465,
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
      tls: { rejectUnauthorized: false }
    });

    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: 'admin@uwo24.com', // As requested
      replyTo: email,
      subject: `New Site Visit Booking: ${name}`,
      html: `
        <div style="font-family: sans-serif; padding: 20px; border: 1px solid #eee; border-radius: 10px;">
          <h2 style="color: #c46a4a;">New Site Visit Booking</h2>
          <p>A new site visit has been booked through the YUG AMC website.</p>
          <hr/>
          <p><strong>Name:</strong> ${name}</p>
          <p><strong>Phone:</strong> ${phone}</p>
          <p><strong>Email:</strong> ${email}</p>
          <p><strong>Preferred Location:</strong> ${location || 'N/A'}</p>
          <p><strong>Budget:</strong> ${budget || 'N/A'}</p>
          <p><strong>Visit Date:</strong> ${visitDate}</p>
          <p><strong>Time Slot:</strong> ${timeSlot || 'N/A'}</p>
          <p><strong>Booking ID:</strong> ${bookingId || 'N/A'}</p>
          <p><strong>Timestamp:</strong> ${new Date().toLocaleString()}</p>
        </div>
      `,
    };

    await transporter.sendMail(mailOptions);
    console.log('[EMAIL SUCCESS] Booking notification sent to admin@uwo24.com');
  } catch (emailError) {
    console.error('[EMAIL ERROR] Failed to send booking email:', emailError.message);
  }

  if (bookingId) {
    res.status(200).json({ success: true, message: 'Your site visit has been booked successfully! Our team will contact you shortly.' });
  } else {
    res.status(500).json({ success: false, message: 'Server error. Please try again or call us directly.' });
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
