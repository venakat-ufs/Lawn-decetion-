export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    mapsKey: process.env.GOOGLE_MAPS_API_KEY || '',
  });
}
