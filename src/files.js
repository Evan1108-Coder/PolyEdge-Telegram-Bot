const fs = require('fs/promises');
const path = require('path');
const axios = require('axios');
const { PDFParse } = require('pdf-parse');
const { getConfig } = require('./config');

const SUPPORTED = {
  text: ['.txt', '.md', '.csv', '.json', '.html'],
  document: ['.pdf', '.rtf'],
  image: ['.png', '.jpg', '.jpeg', '.avif'],
};

function classifyFile(fileName) {
  const ext = path.extname(String(fileName || '')).toLowerCase();
  for (const [kind, extensions] of Object.entries(SUPPORTED)) {
    if (extensions.includes(ext)) return { kind, ext };
  }
  return null;
}

function getSupportedExtensions() { return Object.values(SUPPORTED).flat(); }

async function downloadTelegramFile(api, fileId, fileName) {
  const config = getConfig();
  const file = await api.getFile(fileId);
  const url = `https://api.telegram.org/file/bot${config.telegramToken}/${file.file_path}`;
  const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 60000 });
  const safeName = path.basename(fileName || file.file_path || 'upload.bin');
  const outDir = path.join(config.dataDir || path.join(__dirname, '..', 'data'), 'uploads');
  await fs.mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, `${Date.now()}-${safeName}`);
  await fs.writeFile(outPath, Buffer.from(res.data));
  return outPath;
}

async function extractText(filePath, fileName = filePath) {
  const type = classifyFile(fileName);
  if (!type) throw new Error(`Unsupported file type: ${fileName}`);
  if (type.kind === 'image') return '';
  if (['.txt', '.md', '.csv', '.json', '.html'].includes(type.ext)) return fs.readFile(filePath, 'utf8');
  if (type.ext === '.rtf') return stripRtf(await fs.readFile(filePath, 'utf8'));
  if (type.ext === '.pdf') {
    const parser = new PDFParse({ data: new Uint8Array(await fs.readFile(filePath)) });
    try {
      const result = await parser.getText();
      return result.text || '';
    } finally {
      await parser.destroy?.();
    }
  }
  return '';
}

async function getImageBase64(filePath) { return (await fs.readFile(filePath)).toString('base64'); }

function getMimeType(fileName) {
  const ext = path.extname(String(fileName || '')).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.avif') return 'image/avif';
  return 'application/octet-stream';
}

function stripRtf(raw) {
  return String(raw)
    .replace(/\\'[0-9a-fA-F]{2}/g, ' ')
    .replace(/\\[a-z]+\d* ?/gi, ' ')
    .replace(/[{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function unsupportedFileMessage(fileName) {
  return `I can’t read ${fileName || 'that file'} yet. Supported uploads: ${getSupportedExtensions().join(', ')}.`;
}

function imageCapabilityMessage(fileName) {
  return `I received ${fileName || 'the image'}, but this PolyEdge runtime is currently connected to a text-only MiniMax chat model, so I can’t honestly inspect pixels yet. Send a text/PDF/RTF file or switch this bot to a vision-capable provider before asking for image analysis.`;
}

function voiceCapabilityMessage() {
  return 'I received your voice message, but PolyEdge cannot transcribe audio yet. Please send the request as text; I won’t guess at audio I cannot hear.';
}

function unsupportedAttachmentMessage(kind = 'attachment') {
  return `I received the ${kind}, but PolyEdge cannot process that attachment type yet. Please send text or one of these supported uploads: ${getSupportedExtensions().join(', ')}.`;
}

module.exports = { classifyFile, getSupportedExtensions, downloadTelegramFile, extractText, getImageBase64, getMimeType, stripRtf, unsupportedFileMessage, imageCapabilityMessage, voiceCapabilityMessage, unsupportedAttachmentMessage };
