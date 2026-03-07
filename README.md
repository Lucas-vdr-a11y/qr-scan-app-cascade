# QR Scan App - Rederij Cascade

Een moderne web-based PWA voor het scannen van QR-tickets bij scheepsafvaarten.

## 🚀 Features

- ✅ **QR Code Scanning** - Camera-based scanning met fallback voor handmatige invoer
- ✅ **Groepsreserveringen** - Ondersteuning voor meerdere personen per reservering
- ✅ **Multi-device** - Werkt gelijktijdig op meerdere apparaten
- ✅ **Realtime Updates** - Live status synchronisatie
- ✅ **Schip Filtering** - Filter op Maaslakei of Stadt Wessem
- ✅ **Scan Geschiedenis** - Volledig logboek van alle scans
- ✅ **PWA** - Installeerbaar op mobiele apparaten

## 📋 Vereisten

- Node.js 16+ 
- NPM
- Smart Event Manager (SEM) API toegang

## 🛠️ Installatie

1. **Clone/download het project**

2. **Installeer dependencies**
   ```bash
   npm install
   ```

3. **Configureer environment variabelen**
   
   Kopieer `.env.example` naar `.env`:
   ```bash
   cp .env.example .env
   ```
   
   Vul je SEM API credentials in:
   ```
   PORT=3000
   SEM_API_URL=https://api.smarteventmanager.nl
   SEM_API_KEY=your_actual_api_key_here
   ```

4. **Start de server**
   ```bash
   npm start
   ```
   
   Of voor development met auto-reload:
   ```bash
   npm run dev
   ```

5. **Open de app**
   
   - Lokaal: `http://localhost:3000`
   - Op je netwerk: `http://[je-ip-adres]:3000`

## 📱 Gebruik

### Scanner Scherm
- Scan QR-codes met de camera
- Of voer handmatig een Reservering ID in
- Kies hoeveel personen er binnenkomen
- Bevestig de scan

### Reserveringen Scherm
- Bekijk alle reserveringen van vandaag
- Filter op schip (Maaslakei / Stadt Wessem)
- Zie realtime status (niet gescand / deels / volledig)

### Geschiedenis Scherm
- Bekijk alle uitgevoerde scans
- Zie tijdstip, aantal personen en apparaat

## 🏗️ Architectuur

### Backend (Node.js + Express)
- `server.js` - Express server met API endpoints
- `database.js` - SQLite database setup
- `sem-api.js` - SEM API client

### Frontend (PWA)
- `public/index.html` - HTML structuur
- `public/styles.css` - Premium dark theme styling
- `public/app.js` - JavaScript logica
- `public/manifest.json` - PWA configuratie

### Database Schema

**scan_status**
- `reservation_id` (PK)
- `total_persons`
- `scanned_persons`
- `remaining_persons`
- `last_scan_at`
- `reservation_name`
- `reservation_date`
- `start_time`
- `facility_id`

**scan_history**
- `id` (PK)
- `timestamp`
- `reservation_id`
- `persons_entered`
- `device_id`
- `reservation_name`
- `forced`

## 🔌 API Endpoints

### POST /api/scan
Scan een QR-code en registreer personen.

**Request:**
```json
{
  "reservation_id": 26335,
  "persons_entering": 2,
  "force_allow": false,
  "device_id": "device_abc123"
}
```

**Response:**
```json
{
  "status": "ok",
  "reason": "OK",
  "reservation_name": "Familie Jansen",
  "persons_entered": 2,
  "scanned_persons": 2,
  "remaining_persons": 4,
  "total_persons": 6
}
```

### GET /api/reservations?date=YYYY-MM-DD&facility=9
Haal alle reserveringen op voor een datum en schip.

### GET /api/history
Haal scan geschiedenis op (laatste 100).

### GET /api/status/:reservation_id
Haal status van specifieke reservering op.

## 🚢 Schepen (Facilities)

- **Maaslakei** = FacilityID `9`
- **Stadt Wessem** = FacilityID `10`

## 🔐 Validatie Regels

Een scan wordt geweigerd als:
- ❌ Reservering niet betaald is
- ❌ Datum niet overeenkomt (te vroeg / te laat)
- ❌ Alle personen al gescand zijn

Override mogelijk via "Force Allow" knop.

## 🎨 Design

- **Dark Theme** - Premium donker design
- **Gradient Accents** - Moderne kleurovergangen
- **Micro-animations** - Subtiele animaties voor betere UX
- **Responsive** - Werkt op alle schermformaten
- **Mobile-first** - Geoptimaliseerd voor mobiel gebruik

## 📦 Dependencies

- **express** - Web server
- **axios** - HTTP client voor SEM API
- **better-sqlite3** - SQLite database
- **cors** - CORS middleware
- **dotenv** - Environment variabelen
- **html5-qrcode** - QR code scanner (frontend)

## 🔄 Realtime Synchronisatie

De app pollt elke 10 seconden voor updates op het Reserveringen scherm, zodat alle apparaten de actuele status zien.

## 📝 Licentie

Proprietary - Rederij Cascade

## 👨‍💻 Ontwikkeling

Voor vragen of ondersteuning, neem contact op met het development team.
