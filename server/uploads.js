// server/uploads.js
// Gestion des uploads photos avec multer + redimensionnement sharp
const multer = require('multer');
const sharp  = require('sharp');
const path   = require('path');
const fs     = require('fs');

const UPLOAD_DIR = process.env.UPLOAD_DIR || './public/uploads';
const THUMB_DIR  = path.join(UPLOAD_DIR, 'thumbs');

// Créer les dossiers si absents
[UPLOAD_DIR, THUMB_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

// Config multer : stockage disque, nommage unique
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext  = path.extname(file.originalname).toLowerCase() || '.jpg';
    const name = `inter_${req.params.id}_${Date.now()}${ext}`;
    cb(null, name);
  }
});

const fileFilter = (req, file, cb) => {
  const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic'];
  if (allowed.includes(file.mimetype)) cb(null, true);
  else cb(new Error('Format non supporté. Utilisez JPEG, PNG, WEBP ou GIF.'));
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 15 * 1024 * 1024 } // 15 Mo max par photo
});

// Générer une miniature 300×200 avec sharp
async function makeThumb(filename) {
  const src   = path.join(UPLOAD_DIR, filename);
  const thumb = 'thumb_' + filename.replace(/\.(heic)$/i, '.jpg');
  const dest  = path.join(THUMB_DIR, thumb);
  try {
    await sharp(src)
      .rotate()                      // respecte l'orientation EXIF
      .resize(400, 300, { fit: 'cover', position: 'centre' })
      .jpeg({ quality: 82 })
      .toFile(dest);
    return thumb;
  } catch (e) {
    console.error('Erreur génération miniature :', e.message);
    return null;
  }
}

// Supprimer les fichiers physiques d'une photo
function deleteFiles(filename, filenameThumb) {
  const files = [
    path.join(UPLOAD_DIR, filename),
    filenameThumb ? path.join(THUMB_DIR, filenameThumb) : null
  ].filter(Boolean);
  files.forEach(f => { try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (e) {} });
}

module.exports = { upload, makeThumb, deleteFiles, UPLOAD_DIR, THUMB_DIR };
