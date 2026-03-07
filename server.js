const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();
const fs = require('fs');
const https = require('https');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const { initDatabase, statements } = require('./database');
const semApi = require('./sem-api');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// JWT_SECRET MOET in .env staan — geen onveilige fallback meer
if (!process.env.JWT_SECRET) {
    console.error('❌ FATAAL: JWT_SECRET ontbreekt in .env! Server wordt niet gestart.');
    process.exit(1);
}
const JWT_SECRET = process.env.JWT_SECRET;

const app = express();
const PORT = process.env.PORT || 3000;

// Vertrouw de proxy (Cloudflare Tunnel) voor correcte IP-detectie bij rate limiting
app.set('trust proxy', 1);

// Initialize database first
let serverReady = false;

initDatabase().then(() => {
    serverReady = true;
    console.log('✓ Server ready');
}).catch(err => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
});


// Middleware
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'", "https://unpkg.com"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
            fontSrc: ["'self'", "https://fonts.gstatic.com"],
            imgSrc: ["'self'", "data:", "blob:"],
            connectSrc: ["'self'", "https://scan.varenbijcascade.com"],
            mediaSrc: ["'self'", "blob:"],
            workerSrc: ["'self'", "blob:"]
        }
    }
}));
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Rate limiting op login — max 5 pogingen per 15 minuten per IP
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: { error: 'Te veel inlogpogingen. Probeer het over 15 minuten opnieuw.' },
    standardHeaders: true,
    legacyHeaders: false
});

// Globale rate limiter — max 100 requests per 15 minuten per IP 
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false
});
app.use('/api', apiLimiter);


// ------------------------------------------------------------------
// AUTHENTICATIE & LOGIN
// ------------------------------------------------------------------

app.post('/api/login', loginLimiter, (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ error: 'Vul gebruikersnaam en wachtwoord in' });
    }

    const user = statements.getUser(username);

    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
        return res.status(401).json({ error: 'Ongeldige inloggegevens' });
    }

    const token = jwt.sign(
        { id: user.id, username: user.username, role: user.role },
        JWT_SECRET,
        { expiresIn: '12h' }
    );

    res.json({ token, role: user.role, username: user.username });
});

// Beveilig alle overige /api routes
app.use('/api', (req, res, next) => {
    if (req.path === '/login') return next(); // Should be handled above
    if (req.path === '/scan-statuses') return next(); // Public endpoint for floorplan embed

    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) return res.status(401).json({ error: 'Niet ingelogd' });

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: 'Sessie verlopen' });
        req.user = user;
        next();
    });
});
// ------------------------------------------------------------------

// Helper: huidige datum in YYYY-MM-DD
function getCurrentDate() {
    return new Date().toISOString().split('T')[0];
}

// Helper: huidige timestamp
function getCurrentTimestamp() {
    return new Date().toISOString();
}

/**
 * POST /api/scan
 * Scan een QR-code en registreer personen
 */
app.post('/api/scan', async (req, res) => {
    const { reservation_id, persons_entering, force_allow = false, device_id = 'unknown', tour_leg = null } = req.body;

    // Strikte input validatie
    const parsedId = parseInt(reservation_id);
    const parsedPersons = parseInt(persons_entering);

    if (!Number.isInteger(parsedId) || parsedId <= 0 || parsedId > 99999999) {
        return res.status(400).json({
            status: 'error',
            message: 'Ongeldig reserveringsnummer'
        });
    }

    if (!Number.isInteger(parsedPersons) || parsedPersons < 1 || parsedPersons > 500) {
        return res.status(400).json({
            status: 'error',
            message: 'Ongeldig aantal personen (1-500)'
        });
    }

    // Sanitize device_id (max 50 tekens, alleen alfanumeriek + underscore)
    const safeDeviceId = String(device_id).replace(/[^a-zA-Z0-9_-]/g, '').substring(0, 50) || 'unknown';

    // Valideer tour_leg
    if (tour_leg !== null && tour_leg !== 'heen' && tour_leg !== 'terug') {
        return res.status(400).json({
            status: 'error',
            message: 'Ongeldige tour_leg waarde'
        });
    }

    try {
        // Haal reservering op van SEM
        const reservation = await semApi.getReservation(reservation_id);
        const currentDate = getCurrentDate();

        // Valideer reservering (tenzij force_allow)
        if (!force_allow) {
            const validation = semApi.validateReservation(reservation, currentDate);
            if (!validation.valid) {
                return res.json({
                    status: 'denied',
                    reason: validation.reason,
                    reservation_name: reservation.Name,
                    delivery_address: reservation.Delivery || reservation.DeliveryAddress,
                    contact_name: reservation.ContactPerson?.DisplayName || '',
                    contact_phone: reservation.ContactPerson?.PhoneNumber || '',
                    child_counts: semApi.getChildCounts(reservation),
                    products: (reservation.ReservationProducts?.filter(p =>
                        p.OptionalType === 'OptionalUnselected'
                    ).map(p => ({
                        name: p.ProductName || p.Name || 'Product',
                        quantity: p.NumberOf ?? p.Quantity ?? p.Amount ?? 0
                    })) || []).sort((a, b) => a.name.localeCompare(b.name))
                });
            }
        }

        // Haal huidige scan status op
        let scanStatus = statements.getScanStatus(reservation_id);

        const totalPersons = semApi.getNumberOfPersons(reservation);
        const isTourDeThorn = semApi.isTourDeThorn(reservation);

        if (!scanStatus) {
            // Eerste scan voor deze reservering
            scanStatus = {
                reservation_id,
                total_persons: totalPersons,
                scanned_persons: 0,
                remaining_persons: totalPersons,
                reservation_name: reservation.Name,
                reservation_date: reservation.ReservationDate?.split('T')[0],
                start_time: reservation.StartTime,
                facility_id: semApi.getFacilityIds(reservation)[0] || null,
                tour_leg: null
            };
        }

        // Tour de Thorn speciale logica
        if (isTourDeThorn) {
            // Controleer of deze rit al gescand is
            if (!force_allow && scanStatus.tour_leg === tour_leg) {
                // Deze rit is al gescand
                return res.json({
                    status: 'denied',
                    reason: 'ALREADY_SCANNED',
                    reservation_name: reservation.Name,
                    scanned_persons: scanStatus.tour_leg ? 1 : 0,
                    total_persons: 2,
                    tour_leg: tour_leg,
                    delivery_address: reservation.Delivery || reservation.DeliveryAddress,
                    contact_name: reservation.ContactPerson?.DisplayName || '',
                    contact_phone: reservation.ContactPerson?.PhoneNumber || '',
                    child_counts: semApi.getChildCounts(reservation),
                    products: (reservation.ReservationProducts?.filter(p =>
                        p.OptionalType === 'OptionalUnselected'
                    ).map(p => ({
                        name: p.ProductName || p.Name || 'Product',
                        quantity: p.NumberOf ?? p.Quantity ?? p.Amount ?? 0,
                        notes: p.Notes || ''
                    })) || []).sort((a, b) => a.name.localeCompare(b.name))
                });
            }

            // Sla de gekozen rit op
            const legsScanned = tour_leg ? 1 : 0;

            statements.upsertScanStatus(
                reservation_id,
                2, // Voor Tour de Thorn: 2 ritten (heen + terug)
                legsScanned,
                2 - legsScanned,
                getCurrentTimestamp(),
                reservation.Name,
                reservation.ReservationDate?.split('T')[0],
                reservation.StartTime,
                scanStatus.facility_id,
                tour_leg
            );

            // Voeg toe aan history met speciale notitie
            statements.addScanHistory(
                getCurrentTimestamp(),
                reservation_id,
                persons_entering,
                safeDeviceId,
                `${reservation.Name} (${tour_leg === 'heen' ? 'Heenreis' : 'Terugreis'})`,
                reservation.ContactPerson?.DisplayName || '',
                force_allow ? 1 : 0
            );

            return res.json({
                status: 'ok',
                reason: 'OK',
                reservation_name: reservation.Name,
                persons_entered: persons_entering,
                scanned_persons: legsScanned,
                remaining_persons: 2 - legsScanned,
                total_persons: totalPersons,
                tour_leg: tour_leg,
                tour_status: tour_leg === 'heen' ? 'Heenreis gescand' : 'Terugreis gescand',
                delivery_address: reservation.Delivery || reservation.DeliveryAddress,
                contact_name: reservation.ContactPerson?.DisplayName || '',
                contact_phone: reservation.ContactPerson?.PhoneNumber || '',
                child_counts: semApi.getChildCounts(reservation),
                products: (reservation.ReservationProducts?.filter(p =>
                    p.OptionalType === 'OptionalUnselected'
                ).map(p => ({
                    name: p.ProductName || p.Name || 'Product',
                    quantity: p.NumberOf ?? p.Quantity ?? p.Amount ?? 0,
                    notes: p.Notes || ''
                })) || []).sort((a, b) => a.name.localeCompare(b.name))
            });
        }

        // Normale reservering logica (niet Tour de Thorn)
        // Check of al volledig gescand (tenzij force_allow)
        if (!isTourDeThorn && !force_allow && scanStatus.scanned_persons >= scanStatus.total_persons) {
            return res.json({
                status: 'denied',
                reason: 'ALREADY_SCANNED',
                reservation_name: reservation.Name,
                scanned_persons: scanStatus.scanned_persons,
                total_persons: scanStatus.total_persons,
                delivery_address: reservation.Delivery || reservation.DeliveryAddress,
                contact_name: reservation.ContactPerson?.DisplayName || '',
                contact_phone: reservation.ContactPerson?.PhoneNumber || '',
                child_counts: semApi.getChildCounts(reservation),
                products: (reservation.ReservationProducts?.filter(p =>
                    p.OptionalType === 'OptionalUnselected'
                ).map(p => ({
                    name: p.ProductName || p.Name || 'Product',
                    quantity: p.NumberOf ?? p.Quantity ?? p.Amount ?? 0,
                    notes: p.Notes || ''
                })) || []).sort((a, b) => a.name.localeCompare(b.name))
            });
        }

        // Update scan status
        // Bij override mag het aantal gescande personen het totaal overschrijden
        const newScannedPersons = (scanStatus ? scanStatus.scanned_persons : 0) + persons_entering;
        const newRemainingPersons = totalPersons - newScannedPersons;

        statements.upsertScanStatus(
            reservation_id,
            totalPersons,
            newScannedPersons,
            newRemainingPersons,
            getCurrentTimestamp(),
            reservation.Name,
            reservation.ReservationDate?.split('T')[0],
            reservation.StartTime,
            scanStatus.facility_id,
            null
        );

        // Voeg toe aan history
        statements.addScanHistory(
            getCurrentTimestamp(),
            reservation_id,
            persons_entering,
            safeDeviceId,
            reservation.Name,
            reservation.ContactPerson?.DisplayName || '',
            force_allow ? 1 : 0
        );

        res.json({
            status: 'ok',
            reason: 'OK',
            reservation_name: reservation.Name,
            persons_entered: persons_entering,
            scanned_persons: newScannedPersons,
            remaining_persons: newRemainingPersons,
            total_persons: totalPersons,
            delivery_address: reservation.Delivery || reservation.DeliveryAddress,
            contact_name: reservation.ContactPerson?.DisplayName || '',
            contact_phone: reservation.ContactPerson?.PhoneNumber || '',
            child_counts: semApi.getChildCounts(reservation),
            products: (reservation.ReservationProducts?.filter(p =>
                p.OptionalType === 'OptionalUnselected'
            ).map(p => ({
                name: p.ProductName || p.Name || 'Product',
                quantity: p.NumberOf ?? p.Quantity ?? p.Amount ?? 0,
                notes: p.Notes || ''
            })) || []).sort((a, b) => a.name.localeCompare(b.name))
        });

    } catch (error) {
        console.error('Scan error:', error);
        res.status(500).json({
            status: 'error',
            message: 'Er ging iets mis bij het verwerken van de scan'
        });
    }
});

/**
 * GET /api/reservations
 * Haal alle reserveringen op voor een datum (met scan status)
 */
app.get('/api/reservations', async (req, res) => {
    const { date = getCurrentDate(), facility } = req.query;

    try {
        // Haal reserveringen op van SEM
        const reservations = await semApi.getReservations(date);

        // Filter op facility indien opgegeven
        let filteredReservations = reservations;
        if (facility) {
            const facilityId = parseInt(facility);
            filteredReservations = reservations.filter(r =>
                r.ReservationFacilities?.some(f => f.FacilityID === facilityId)
            );
        }

        // Filter nulboekingen (Online publiceren ja = ReservationCodingChoiceID 1)
        filteredReservations = filteredReservations.filter(r => {
            if (!r.ReservationCodings || r.ReservationCodings.length === 0) {
                return true; // Geen codering = tonen
            }
            // Verberg als ReservationCodingChoiceID = 1 (Online publiceren ja)
            return !r.ReservationCodings.some(c => c.ReservationCodingChoiceID === 1);
        });

        // Haal scan status op uit database
        const scanStatuses = facility
            ? statements.getScanStatusByFacility(date, parseInt(facility))
            : statements.getAllScanStatus(date);


        const statusMap = {};
        scanStatuses.forEach(s => {
            statusMap[s.reservation_id] = s;
        });

        // Combineer data
        const result = filteredReservations.map(r => {
            const scanStatus = statusMap[r.ReservationID];
            const totalPersons = semApi.getNumberOfPersons(r);


            return {
                reservation_id: r.ReservationID,
                name: r.Name,
                date: r.ReservationDate?.split('T')[0],
                start_time: r.StartTime,
                end_time: r.EndTime,
                total_persons: totalPersons,
                scanned_persons: scanStatus?.scanned_persons || 0,
                remaining_persons: scanStatus?.remaining_persons || totalPersons,
                facilities: r.ReservationFacilities?.map(f => ({
                    id: f.FacilityID,
                    name: f.FacilityName
                })) || [],
                scan_status: scanStatus ? (
                    scanStatus.scanned_persons === 0 ? 'not_scanned' :
                        scanStatus.remaining_persons <= 0 ? 'complete' : 'partial'
                ) : 'not_scanned',
                tour_leg: scanStatus?.tour_leg || null,
                delivery_address: r.Delivery || r.DeliveryAddress,
                contact_name: r.ContactPerson?.DisplayName || '',
                contact_phone: r.ContactPerson?.PhoneNumber || '',
                child_counts: semApi.getChildCounts(r),
                products: (r.ReservationProducts?.filter(p =>
                    p.OptionalType === 'OptionalUnselected'
                ).map(p => ({
                    name: p.ProductName || p.Name || 'Product',
                    quantity: p.NumberOf ?? p.Quantity ?? p.Amount ?? 0,
                    notes: p.Notes || ''
                })) || []).sort((a, b) => a.name.localeCompare(b.name))
            };
        });

        res.json(result);

    } catch (error) {
        console.error('Error fetching reservations:', error);
        res.status(500).json({
            status: 'error',
            message: 'Kan reserveringen niet ophalen'
        });
    }
});

/**
 * GET /api/stats
 * Haal statistieken op voor de huidige datum en/of schip
 */
app.get('/api/stats', async (req, res) => {
    try {
        const date = req.query.date || getCurrentDate();
        const facility = req.query.facility;

        const reservations = await semApi.getReservations(date);

        // Filter alleen actieve of optie-reserveringen
        let filtered = reservations.filter(r =>
            r.ReservationStatus === 'Approved' ||
            r.ReservationStatus === 'Option' ||
            r.ReservationStatus === 'Active'
        );

        if (facility) {
            filtered = filtered.filter(r =>
                r.ReservationFacilities?.some(f => f.FacilityID === parseInt(facility))
            );
        }

        // Verberg als ReservationCodingChoiceID = 1 (Online publiceren ja = Nulboeking)
        filtered = filtered.filter(r =>
            !r.ReservationCodings.some(c => c.ReservationCodingChoiceID === 1)
        );

        const scanStatuses = facility
            ? statements.getScanStatusByFacility(date, parseInt(facility))
            : statements.getAllScanStatus(date);

        const statusMap = {};
        scanStatuses.forEach(s => {
            statusMap[s.reservation_id] = s;
        });

        let expected = 0;
        let scanned = 0;

        filtered.forEach(r => {
            const totalPersons = semApi.getNumberOfPersons(r);
            const scanStatus = statusMap[r.ReservationID];

            expected += totalPersons;
            if (scanStatus) scanned += scanStatus.scanned_persons;
        });

        res.json({
            date,
            facility: facility || 'all',
            expected,
            scanned,
            percentage: expected > 0 ? Math.round((scanned / expected) * 100) : 0
        });

    } catch (error) {
        console.error('Error fetching stats:', error);
        res.status(500).json({ status: 'error', message: 'Kan statistieken niet ophalen' });
    }
});

/**
 * GET /api/history/export
 * Genereer een CSV-bestand van de scangeschiedenis
 */
app.get('/api/history/export', (req, res) => {
    try {
        const history = statements.getScanHistory();

        // Define CSV headers
        let csv = 'ID,DatumTijd,ReserveringID,ReserveringNaam,Contact,AantalPersonen,Apparaat,Override\n';

        // Append rows
        history.forEach(h => {
            const date = new Date(h.timestamp).toLocaleString('nl-NL');
            const name = `"${(h.reservation_name || '').replace(/"/g, '""')}"`;
            const contact = `"${(h.contact_name || '').replace(/"/g, '""')}"`;
            const forced = h.forced ? 'Ja' : 'Nee';

            csv += `${h.id},"${date}",${h.reservation_id},${name},${contact},${h.persons_entered},${h.device_id},${forced}\n`;
        });

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="qr-scans-${getCurrentDate()}.csv"`);
        res.send(csv);

    } catch (error) {
        console.error('Error exporting history:', error);
        res.status(500).send('Kan export niet genereren');
    }
});

/**
 * GET /api/history
 * Haal scan geschiedenis op (JSON)
 */
app.get('/api/history', (req, res) => {
    try {
        const history = statements.getScanHistory();
        res.json(history);

    } catch (error) {
        console.error('Error fetching history:', error);
        res.status(500).json({
            status: 'error',
            message: 'Kan geschiedenis niet ophalen'
        });
    }
});

/**
 * DELETE /api/history/:id
 * Verwijder een specifieke scan (Undo)
 */
app.delete('/api/history/:id', (req, res) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Geen rechten' });
    }

    try {
        const id = parseInt(req.params.id);
        const scan = statements.getScanHistoryById(id);

        if (!scan) {
            return res.status(404).json({ error: 'Scan niet gevonden' });
        }

        // Check of er een status is om aan te passen
        const status = statements.getScanStatus(scan.reservation_id);
        if (status) {
            // Bereken nieuwe totalen (zorg dat scanned niet onder 0 gaat)
            const newScanned = Math.max(0, status.scanned_persons - scan.persons_entered);
            const newRemaining = status.total_persons - newScanned;

            statements.upsertScanStatus(
                status.reservation_id,
                status.total_persons,
                newScanned,
                newRemaining,
                status.last_scan_at,
                status.reservation_name,
                status.reservation_date,
                status.start_time,
                status.facility_id,
                status.tour_leg
            );
        }

        statements.deleteScanHistory(id);
        res.json({ success: true, message: 'Scan succesvol ongedaan gemaakt' });

    } catch (error) {
        console.error('Error deleting scan:', error);
        res.status(500).json({ error: 'Kan scan niet ongedaan maken' });
    }
});

/**
 * GET /api/reservation/:reservation_id
 * Haal volledige reserveringsgegevens op van SEM API + scan status
 */
app.get('/api/reservation/:reservation_id', async (req, res) => {
    const reservationId = parseInt(req.params.reservation_id);

    if (!Number.isInteger(reservationId) || reservationId <= 0 || reservationId > 99999999) {
        return res.status(400).json({ status: 'error', message: 'Ongeldig reserveringsnummer' });
    }

    try {
        // Haal reservering op van SEM
        const reservation = await semApi.getReservation(reservationId);

        if (!reservation) {
            return res.status(404).json({
                status: 'error',
                message: 'Reservering niet gevonden'
            });
        }

        // Haal scan status op uit database
        const scanStatus = statements.getScanStatus(reservationId);

        const totalPersons = semApi.getNumberOfPersons(reservation);
        const scannedPersons = scanStatus?.scanned_persons || 0;
        const remainingPersons = totalPersons - scannedPersons;

        // Valideer reservering
        const currentDate = getCurrentDate();
        const validation = semApi.validateReservation(reservation, currentDate);

        // Verzamel warnings
        const warnings = [];
        if (!validation.valid) {
            const warningMessages = {
                'NOT_PAID': 'Reservering is niet volledig betaald',
                'CANCELLED': 'Reservering is GEANNULEERD',
                'TOO_EARLY': 'Reservering is voor een latere datum',
                'TOO_LATE': 'Reservering is verlopen',
                'RESERVATION_NOT_FOUND': 'Reservering niet gevonden'
            };
            warnings.push(warningMessages[validation.reason] || validation.reason);
        }

        if (scannedPersons >= totalPersons) {
            warnings.push('Alle personen zijn al gescand');
        }

        // Return comprehensive data
        res.json({
            reservation_id: reservationId,
            reservation_name: reservation.Name,
            reservation_date: reservation.ReservationDate?.split('T')[0],
            start_time: reservation.StartTime,
            end_time: reservation.EndTime,
            total_persons: totalPersons,
            scanned_persons: scannedPersons,
            remaining_persons: remainingPersons,
            facilities: reservation.ReservationFacilities?.map(f => ({
                id: f.FacilityID,
                name: f.FacilityName
            })) || [],
            is_valid: validation.valid,
            validation_reason: validation.reason,
            validation_warnings: warnings,
            tour_leg: scanStatus?.tour_leg || null,
            note: reservation.Note, // Interne notitie
            internal_notes: reservation.InternalNotes || '', // Interne notities
            delivery_address: reservation.Delivery || reservation.DeliveryAddress, // Bevat tafelnummers (T1, T2...)
            contact_name: reservation.ContactPerson?.DisplayName || '',
            contact_phone: reservation.ContactPerson?.PhoneNumber || '',
            child_counts: semApi.getChildCounts(reservation),
            products: (reservation.ReservationProducts?.filter(p =>
                p.OptionalType === 'OptionalUnselected'
            ).map(p => ({
                name: p.ProductName || p.Name || 'Product',
                quantity: p.NumberOf ?? p.Quantity ?? p.Amount ?? 0,
                notes: p.Notes || ''
            })) || []).sort((a, b) => a.name.localeCompare(b.name))
        });

    } catch (error) {
        console.error('Error fetching reservation:', error);
        res.status(500).json({
            status: 'error',
            message: 'Fout bij ophalen reservering'
        });
    }
});

/**
 * GET /api/status/:reservation_id
 * Haal status van specifieke reservering op
 */
app.get('/api/status/:reservation_id', (req, res) => {
    const reservationId = parseInt(req.params.reservation_id);

    if (!Number.isInteger(reservationId) || reservationId <= 0 || reservationId > 99999999) {
        return res.status(400).json({ status: 'error', message: 'Ongeldig reserveringsnummer' });
    }

    try {
        const status = statements.getScanStatus(reservationId);

        if (!status) {
            return res.json({
                found: false,
                scanned_persons: 0
            });
        }

        res.json({
            found: true,
            ...status
        });

    } catch (error) {
        console.error('Error fetching status:', error);
        res.status(500).json({
            status: 'error',
            message: 'Kan status niet ophalen'
        });
    }
});

// ------------------------------------------------------------------
// GEBRUIKERS BEHEER (Admin Only)
// ------------------------------------------------------------------

app.get('/api/users', (req, res) => {
    if (req.user.role !== 'admin') return res.sendStatus(403);
    const users = statements.getAllUsers();
    res.json(users);
});

app.post('/api/users', (req, res) => {
    if (req.user.role !== 'admin') return res.sendStatus(403);

    const { username, password, role } = req.body;

    if (!username || !password || !role) {
        return res.status(400).json({ error: 'Alle velden invullen' });
    }

    // Check if exists
    if (statements.getUser(username)) {
        return res.status(409).json({ error: 'Gebruikersnaam bestaat al' });
    }

    const hash = bcrypt.hashSync(password, 10);
    statements.createUser(username, hash, role);

    res.json({ status: 'ok' });
});

app.delete('/api/users/:id', (req, res) => {
    if (req.user.role !== 'admin') return res.sendStatus(403);

    const id = req.params.id;

    // Prevent deleting self
    if (parseInt(id) === req.user.id) {
        return res.status(400).json({ error: 'Je kunt jezelf niet verwijderen' });
    }

    statements.deleteUser(id);
    res.json({ status: 'ok' });
});

app.put('/api/users/:id', (req, res) => {
    if (req.user.role !== 'admin') return res.sendStatus(403);

    const id = parseInt(req.params.id);
    const { role, password } = req.body;

    // Check user exists
    const user = statements.getUserById(id);
    if (!user) {
        return res.status(404).json({ error: 'Gebruiker niet gevonden' });
    }

    // Prevent editing built-in admin username
    if (user.username === 'admin' && role && role !== 'admin') {
        return res.status(400).json({ error: 'Kan de admin account niet wijzigen naar een andere rol' });
    }

    // Update role if provided
    if (role && ['admin', 'user'].includes(role)) {
        statements.updateUserRole(id, role);
    }

    // Update password if provided
    if (password && password.length >= 6) {
        const hash = bcrypt.hashSync(password, 10);
        statements.updateUserPassword(id, hash);
    } else if (password && password.length > 0) {
        return res.status(400).json({ error: 'Wachtwoord moet minimaal 6 tekens zijn' });
    }

    res.json({ status: 'ok' });
});

// ------------------------------------------------------------------
// PLATTEGROND / FLOORPLAN (Vaarplanner Embed)
// ------------------------------------------------------------------

/**
 * GET /api/scan-statuses?date=YYYY-MM-DD
 * Publiek endpoint — retourneert scan statussen per reservering.
 * Gebruikt door de vaarplanner embed om tafels te kleuren.
 */
app.get('/api/scan-statuses', (req, res) => {
    // Allow cross-origin requests from the vaarplanner
    res.header('Access-Control-Allow-Origin', '*');

    const { date = getCurrentDate() } = req.query;

    try {
        const statuses = statements.getAllScanStatus(date);

        // Return as object keyed by reservation_id
        const result = {};
        statuses.forEach(s => {
            result[s.reservation_id] = {
                scanned_persons: s.scanned_persons,
                total_persons: s.total_persons,
                remaining_persons: s.remaining_persons,
                status: s.scanned_persons === 0 ? 'not_scanned'
                    : s.remaining_persons <= 0 ? 'complete'
                        : 'partial'
            };
        });

        res.json(result);
    } catch (error) {
        console.error('Error fetching scan statuses:', error);
        res.status(500).json({});
    }
});

/**
 * GET /api/departures?date=YYYY-MM-DD&facility=ID
 * Haal vertrek-reserveringen op (CodingChoiceID=1) voor de plattegrond
 */
app.get('/api/departures', async (req, res) => {
    const { date = getCurrentDate(), facility } = req.query;

    try {
        const reservations = await semApi.getReservations(date);

        // Filter alleen vertrek-reserveringen (CodingChoiceID === 1)
        let departures = reservations.filter(r =>
            r.ReservationCodings?.some(c => c.ReservationCodingChoiceID === 1)
        );

        // Filter op facility indien opgegeven
        if (facility) {
            const facilityId = parseInt(facility);
            departures = departures.filter(r =>
                r.ReservationFacilities?.some(f => f.FacilityID === facilityId)
            );
        }

        const result = departures.map(r => ({
            reservation_id: r.ReservationID,
            name: r.Name,
            start_time: r.StartTime,
            end_time: r.EndTime,
            facilities: r.ReservationFacilities?.map(f => ({
                id: f.FacilityID,
                name: f.FacilityName
            })) || []
        }));

        res.json(result);

    } catch (error) {
        console.error('Error fetching departures:', error);
        res.status(500).json({
            status: 'error',
            message: 'Failed to fetch departures'
        });
    }
});

/**
 * POST /api/floorplan-token
 * Vraagt een tijdelijke embed token aan bij de vaarplanner.
 * API key blijft veilig op de server.
 */
app.post('/api/floorplan-token', async (req, res) => {
    const vaarplannerUrl = process.env.VAARPLANNER_URL;
    const apiKey = process.env.VAARPLANNER_API_KEY;

    if (!vaarplannerUrl || !apiKey) {
        return res.status(503).json({
            status: 'error',
            message: 'Plattegrond niet geconfigureerd (VAARPLANNER_URL / VAARPLANNER_API_KEY ontbreekt)'
        });
    }

    const { departureId, date } = req.body;
    if (!departureId || !date) {
        return res.status(400).json({ error: 'departureId en date zijn verplicht' });
    }

    try {
        const axios = require('axios');
        const tokenRes = await axios.post(`${vaarplannerUrl}/api/embed/token`, {
            departureId: String(departureId),
            date
        }, {
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            }
        });

        // Pass the embed URL back to the frontend
        res.json({ url: tokenRes.data.url });
    } catch (error) {
        console.error('Floorplan token error:', error?.response?.data || error.message);
        res.status(502).json({
            status: 'error',
            message: 'Kon geen embed token aanvragen bij de vaarplanner'
        });
    }
});

// Serve frontend
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
// Start servers
// HTTP Server
app.listen(PORT, () => {
    console.log(`🚢 HTTP Server running on http://localhost:${PORT}`);
});

// HTTPS Server (voor Android Camera support)
try {
    if (fs.existsSync('server.key') && fs.existsSync('server.cert')) {
        const privateKey = fs.readFileSync('server.key', 'utf8');
        const certificate = fs.readFileSync('server.cert', 'utf8');
        const credentials = { key: privateKey, cert: certificate };

        const httpsServer = https.createServer(credentials, app);

        httpsServer.listen(3443, () => {
            console.log(`🔒 HTTPS Server running on https://localhost:3443`);
            console.log(`📱 Android: Gebruik https://[JOUW-IP]:3443 (accepteer beveiligingswaarschuwing)`);
        });
    } else {
        console.log('⚠️ Geen SSL certificaten gevonden (server.key/server.cert), HTTPS niet gestart.');
    }
} catch (error) {
    console.error('HTTPS Server Error:', error);
}
