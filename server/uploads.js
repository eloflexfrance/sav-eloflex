// server/uploads.js — stockage Cloudinary (prod) ou disque local (dev)
const multer = require('multer');
const path   = require('path');
const fs     = require('fs');

const USE_CLOUDINARY = !!(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET);

let cloudinary;
if (USE_CLOUDINARY) {
  cloudinary = require('cloudinary').v2;
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key:    process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });
  console.log('📸 Stockage photos : Cloudinary');
} else {
  console.log('📸 Stockage photos : disque local (Cloudinary non configuré)');
}

// Dossiers locaux (fallback ou dev)
const UPLOAD_DIR = process.env.UPLOAD_DIR || './public/uploads';
const THUMB_DIR  = path.join(UPLOAD_DIR, 'thumbs');
[UPLOAD_DIR, THUMB_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

// Multer : mémoire si Cloudinary, disque sinon
const storage = USE_CLOUDINARY
  ? multer.memoryStorage()
  : multer.diskStorage({
      destination: (req, file, cb) => cb(null, UPLOAD_DIR),
      filename: (req, file, cb) => {
        const ext  = path.extname(file.originalname).toLowerCase() || '.jpg';
        cb(null, `inter_${req.params.id}_${Date.now()}${ext}`);
      }
    });

const fileFilter = (req, file, cb) => {
  const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
  if (allowed.includes(file.mimetype)) cb(null, true);
  else cb(new Error('Format non supporté. Utilisez JPEG, PNG ou WEBP.'));
};

const upload = multer({ storage, fileFilter, limits: { fileSize: 15 * 1024 * 1024 } });

// ── Preuve de livraison (PDF généralement, parfois photo du bon signé) ──
const LIVRAISON_DIR = path.join(UPLOAD_DIR, 'livraisons');
if (!fs.existsSync(LIVRAISON_DIR)) fs.mkdirSync(LIVRAISON_DIR, { recursive: true });

// Toujours memoryStorage pour les livraisons : le buffer est disponible pour base64 DB (Render éphémère)
const uploadPreuveLivraison = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    const allowed = ['application/pdf', 'image/jpeg', 'image/png'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Format non supporté. Utilisez un PDF, JPEG ou PNG.'));
  },
  limits: { fileSize: 15 * 1024 * 1024 }
});

async function savePreuveLivraison(file, commandeId) {
  if (USE_CLOUDINARY) {
    const result = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder: `sav-eloflex/livraisons`, resource_type: 'auto', public_id: `livraison_${commandeId}_${Date.now()}` },
        (err, result) => err ? reject(err) : resolve(result)
      );
      stream.end(file.buffer);
    });
    return { filename: result.public_id, url: result.secure_url, taille: file.size, mime: file.mimetype, storage: 'cloudinary' };
  }
  // Stockage local : écrire le buffer sur le disque
  const ext = path.extname(file.originalname).toLowerCase() || '.pdf';
  const filename = `livraison_${commandeId}_${Date.now()}${ext}`;
  const filepath = path.join(LIVRAISON_DIR, filename);
  fs.writeFileSync(filepath, file.buffer);
  return { filename, url: `/uploads/livraisons/${filename}`, taille: file.size, mime: file.mimetype, storage: 'local' };
}

function deletePreuveLivraisonFile(filename, storage) {
  if (storage === 'cloudinary') { cloudinary.uploader.destroy(filename, { resource_type: 'auto' }).catch(()=>{}); return; }
  try { const f = path.join(LIVRAISON_DIR, filename); if (fs.existsSync(f)) fs.unlinkSync(f); } catch(e) {}
}

// Upload vers Cloudinary ou disque
async function savePhoto(file, interId) {
  if (USE_CLOUDINARY) {
    const result = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder: `sav-eloflex/inter_${interId}`, transformation: [{ quality: 'auto', fetch_format: 'auto' }] },
        (err, result) => err ? reject(err) : resolve(result)
      );
      stream.end(file.buffer);
    });
    return {
      filename: result.public_id,
      filename_thumb: result.public_id,
      url: result.secure_url,
      url_thumb: cloudinary.url(result.public_id, { width: 400, height: 300, crop: 'fill', quality: 'auto' }),
      taille: file.size,
      mime: file.mimetype,
      storage: 'cloudinary'
    };
  } else {
    // Stockage local avec sharp
    const sharp = require('sharp');
    const ext   = path.extname(file.originalname).toLowerCase() || '.jpg';
    const fname = `inter_${interId}_${Date.now()}${ext}`;
    const thumb = `thumb_${fname.replace(/\.[^.]+$/, '.jpg')}`;
    await sharp(file.path).rotate().resize(400,300,{fit:'cover'}).jpeg({quality:82}).toFile(path.join(THUMB_DIR, thumb));
    return { filename: fname, filename_thumb: thumb, url: null, url_thumb: null, taille: file.size, mime: file.mimetype, storage: 'local' };
  }
}

async function makeThumb(filename) {
  if (USE_CLOUDINARY) return filename; // Cloudinary génère les thumbs à la volée
  const sharp = require('sharp');
  const src   = path.join(UPLOAD_DIR, filename);
  const thumb = 'thumb_' + filename.replace(/\.(heic)$/i, '.jpg');
  const dest  = path.join(THUMB_DIR, thumb);
  try {
    await sharp(src).rotate().resize(400,300,{fit:'cover',position:'centre'}).jpeg({quality:82}).toFile(dest);
    return thumb;
  } catch(e) { console.error('Erreur miniature:', e.message); return null; }
}

function deleteFiles(filename, filenameThumb) {
  if (USE_CLOUDINARY) {
    cloudinary.uploader.destroy(filename).catch(()=>{});
    return;
  }
  [path.join(UPLOAD_DIR, filename), filenameThumb ? path.join(THUMB_DIR, filenameThumb) : null]
    .filter(Boolean).forEach(f => { try { if(fs.existsSync(f)) fs.unlinkSync(f); } catch(e){} });
}

function getPhotoUrl(filename, isThumb = false) {
  if (USE_CLOUDINARY) {
    if (isThumb) return cloudinary.url(filename, { width:400, height:300, crop:'fill', quality:'auto', secure:true });
    return cloudinary.url(filename, { quality:'auto', fetch_format:'auto', secure:true });
  }
  return isThumb ? `/uploads/thumbs/${filename}` : `/uploads/${filename}`;
}

// Upload spécifique pour les fichiers Excel (import)
const uploadExcel = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    const allowed = [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel',
      'application/octet-stream'
    ];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(file.mimetype) || ext === '.xlsx' || ext === '.xls') {
      cb(null, true);
    } else {
      cb(new Error('Format non supporté. Utilisez un fichier Excel (.xlsx ou .xls)'));
    }
  },
  limits: { fileSize: 50 * 1024 * 1024 } // 50 Mo max
});

module.exports = { upload, uploadExcel, uploadPreuveLivraison, makeThumb, deleteFiles, getPhotoUrl, savePhoto, savePreuveLivraison, deletePreuveLivraisonFile, UPLOAD_DIR, THUMB_DIR, USE_CLOUDINARY };
