# 🔌 SEM API Configuratie

## API Authenticatie

De SmartEventManager API gebruikt **ApiKey** authenticatie (niet Bearer tokens).

### 1. Verkrijg je API Key

Neem contact op met SmartEventManager support om een API key te verkrijgen voor je organisatie.

### 2. Configureer .env

Open `.env` en vul in:

```bash
SEM_API_URL=https://jouworganisatie.smarteventmanager.com
SEM_API_KEY=jouw-guid-api-key-hier
```

**Let op:** 
- Vervang `jouworganisatie` met je eigen SEM subdomain
- De API key is een GUID formaat (bijv. `12345678-1234-1234-1234-123456789abc`)

### 3. Test de Verbinding

Start de server:
```bash
npm start
```

Ga naar het Reserveringen scherm in de app. Als de API key correct is, zie je de reserveringen van vandaag.

## API Endpoints die worden gebruikt

De app gebruikt de volgende SEM API endpoints:

### GetReservations
```
POST /api/Reservations/GetReservations
```
Haalt alle reserveringen op voor een specifieke dag.

**Request:**
```json
{
  "ReservationsFilter": {
    "FromReservationDate": "2026-02-08",
    "ToReservationDate": "2026-02-08",
    "IncludeRecurring": true,
    "DoApplyDayBoundary": false
  },
  "ReservationLoadOptions": {
    "DoLoadReservationFacilities": true,
    "DoLoadReservationStatus": true,
    "DoLoadContactPerson": true,
    "DoLoadRelation": true
  }
}
```

### GetReservation
```
POST /api/Reservations/GetReservation
```
Haalt één specifieke reservering op (voor scan-validatie).

**Request:**
```json
{
  "ReservationID": 26335,
  "ReservationLoadOptions": {
    "DoLoadReservationFacilities": true,
    "DoLoadReservationStatus": true,
    "DoLoadReservationPayments": true,
    "DoLoadReservationInvoices": true,
    "DoLoadContactPerson": true,
    "DoLoadRelation": true
  }
}
```

## Data Mapping

### Faciliteiten (Schepen)

De app filtert op basis van `FacilityID`:

- **Maaslakei** = `FacilityID: 9`
- **Stadt Wessem** = `FacilityID: 10`

Als je andere schepen hebt, pas deze IDs aan in:
- `public/index.html` (toggle buttons, regel ~48-53)
- `public/app.js` (currentFacility, regel ~7)

### Aantal Personen

SEM kan aantal personen op twee manieren retourneren:
- `NumberOfPersons` (int) - preferred
- `NumberOfPersonsText` (string) - fallback

De app parseert beide automatisch via `semApi.getNumberOfPersons()`.

### Betaalstatus

De app controleert of een reservering betaald is via:

1. **Facturen** (`Invoices`): Check of `PaidAmount >= TotalPriceIn`
2. **Betalingen** (`ReservationPayments`): Check of er betalingen zijn

**Voor demo/test:** Als er geen facturen zijn, wordt de reservering toch geaccepteerd.

Voor productie kun je dit strenger maken in `sem-api.js` → `validateReservation()`.

## Validatie Regels

Bij het scannen wordt gecontroleerd:

✅ **Reservering bestaat** - anders: `RESERVATION_NOT_FOUND`  
✅ **Is betaald** - anders: `NOT_PAID`  
✅ **Datum is vandaag** - anders: `TOO_EARLY` of `TOO_LATE`  
✅ **Niet al volledig gescand** - anders: `ALREADY_SCANNED`

Deze regels kunnen worden overschreven met de **"Force Allow"** knop.

## Troubleshooting

### "Failed to fetch reservations from SEM API"

**Mogelijke oorzaken:**
1. **Verkeerde API URL** - Check of je subdomain klopt
2. **Ongeldige API Key** - Verifieer de GUID in `.env`
3. **Netwerk/firewall** - Check of je server toegang heeft tot SEM API
4. **API Key rechten** - Vraag SEM support of je key toegang heeft tot Reservations endpoints

**Debug:**
Check de server logs voor meer details:
```bash
npm start
# Kijk naar console output voor SEM API errors
```

### "401 Unauthorized"

Je API key is ongeldig of ontbreekt. Check `.env` file.

### "400 Bad Request"

De request body klopt niet. Dit zou niet moeten gebeuren - neem contact op voor support.

### Geen reserveringen zichtbaar

1. Check of er reserveringen zijn voor **vandaag** in SEM
2. Check of de reserveringen gekoppeld zijn aan de juiste **Facility** (9 of 10)
3. Probeer de datum handmatig te testen:
   ```bash
   curl -X POST https://jouworganisatie.smarteventmanager.com/api/Reservations/GetReservations \
     -H "ApiKey: jouw-api-key" \
     -H "Content-Type: application/json" \
     -d '{"ReservationsFilter":{"FromReservationDate":"2026-02-08","ToReservationDate":"2026-02-08"}}'
   ```

## API Documentatie

Volledige SEM API documentatie is beschikbaar via SmartEventManager support.

Belangrijke controllers:
- **ReservationsController** - Reserveringen beheren
- **RelationsController** - Klanten/relaties
- **FacilitiesController** - Locaties/ruimtes
- **InvoicesController** - Facturen

## Rate Limiting

SEM API heeft mogelijk rate limits. Voor productie gebruik:
- Cache reserveringen lokaal (bijv. 30 seconden)
- Gebruik polling interval van minimaal 10 seconden
- Implementeer exponential backoff bij errors

## Beveiliging

⚠️ **Belangrijk:**
- Bewaar je API key **NOOIT** in git
- Gebruik `.env` file (staat al in `.gitignore`)
- Voor productie: gebruik environment variables op de server
- Roteer je API key regelmatig

## Support

Voor vragen over de SEM API:
- 📧 Contact SmartEventManager support
- 📚 Vraag om de volledige API documentatie
- 🔑 Vraag om API key met juiste rechten voor je use case
