const axios = require('axios');
require('dotenv').config();

const SEM_API_URL = process.env.SEM_API_URL || 'https://api.smarteventmanager.nl';
const SEM_API_KEY = process.env.SEM_API_KEY;

// Axios instance met SEM API configuratie
const semClient = axios.create({
    baseURL: SEM_API_URL,
    headers: {
        'Content-Type': 'application/json',
        'ApiKey': SEM_API_KEY
    },
    timeout: 10000
});

/**
 * Haal alle reserveringen op voor een specifieke dag
 */
async function getReservations(date) {
    try {
        const response = await semClient.post('/api/Reservations/GetReservations', {
            ReservationsFilter: {
                FromReservationDate: date,
                ToReservationDate: date,
                IncludeRecurring: true,
                DoApplyDayBoundary: false
            },
            ReservationLoadOptions: {
                DoLoadReservationFacilities: true,
                DoLoadReservationStatus: true,
                DoLoadContactPerson: true,
                DoLoadRelation: true,
                DoLoadReservationProducts: true,
                DoLoadReservationFinance: true,
                DoLoadReservationPayments: true,
                DoLoadReservationInvoices: true,
                DoLoadReservationDiscounts: true,
                DoLoadReservationCodings: true
            }
        });

        return response.data.Reservations || [];
    } catch (error) {
        console.error('Error fetching reservations from SEM:', error.message);
        throw new Error('Failed to fetch reservations from SEM API');
    }
}

/**
 * Haal één specifieke reservering op
 */
async function getReservation(reservationId) {
    try {
        const response = await semClient.post('/api/Reservations/GetReservation', {
            ReservationID: parseInt(reservationId),
            ReservationLoadOptions: {
                DoLoadReservationFacilities: true,
                DoLoadReservationStatus: true,
                DoLoadReservationPayments: true,
                DoLoadReservationInvoices: true,
                DoLoadContactPerson: true,
                DoLoadRelation: true,
                DoLoadReservationProducts: true,
                DoLoadReservationFinance: true,
                DoLoadReservationDiscounts: true,
                DoLoadReservationCodings: true
            }
        });

        return response.data.Reservation;
    } catch (error) {
        console.error(`Error fetching reservation ${reservationId}:`, error.message);
        throw new Error('Failed to fetch reservation from SEM API');
    }
}

/**
 * Valideer of een reservering geldig is voor scanning
 */
function validateReservation(reservation, currentDate) {
    if (!reservation) {
        return { valid: false, reason: 'RESERVATION_NOT_FOUND' };
    }

    // 1. Check status (Geannuleerd)
    if (reservation.ReservationStatus && (reservation.ReservationStatus.IsCancelled || reservation.ReservationStatus.Name === 'Geannuleerd')) {
        return { valid: false, reason: 'CANCELLED' };
    }

    // 2. Check betaalstatus (Strikt)
    // De reservering is pas geldig als er geen openstaand bedrag meer is (OpenAmount <= 0)
    const openAmount = (reservation.OpenAmount !== null && reservation.OpenAmount !== undefined) ? parseFloat(reservation.OpenAmount) : null;

    if (openAmount !== null) {
        if (openAmount > 0.01) {
            return { valid: false, reason: 'NOT_PAID' };
        }
    } else {
        // Fallback: bereken op basis van producten als OpenAmount null is
        let totalPrice = reservation.TotalPriceIn || 0;
        if (totalPrice === 0 && reservation.ReservationProducts) {
            totalPrice = reservation.ReservationProducts.reduce((sum, p) => sum + (p.PriceIn || 0), 0);
        }

        // Trek kortingen eraf
        if (reservation.ReservationDiscounts && Array.isArray(reservation.ReservationDiscounts)) {
            const totalDiscount = reservation.ReservationDiscounts.reduce((sum, d) => sum + (d.AmountIn || 0), 0);
            totalPrice -= totalDiscount;
        }

        let totalPaid = 0;
        if (reservation.ReservationPayments) {
            totalPaid = reservation.ReservationPayments.reduce((sum, p) => sum + (p.Amount || 0), 0);
        }
        if (reservation.Invoices) {
            const invoicePaid = reservation.Invoices.reduce((sum, i) => sum + (i.PaidAmount || 0), 0);
            totalPaid = Math.max(totalPaid, invoicePaid);
        }

        if (totalPrice > 0.01 && totalPaid < (totalPrice - 0.01)) {
            return { valid: false, reason: 'NOT_PAID' };
        }
    }

    // 3. Check datum
    const reservationDate = reservation.ReservationDate?.split('T')[0];
    if (reservationDate !== currentDate) {
        if (reservationDate < currentDate) {
            return { valid: false, reason: 'TOO_LATE' };
        } else {
            return { valid: false, reason: 'TOO_EARLY' };
        }
    }

    return { valid: true, reason: 'OK' };
}

function getFacilityIds(reservation) {
    if (!reservation.ReservationFacilities || !Array.isArray(reservation.ReservationFacilities)) {
        return [];
    }
    return reservation.ReservationFacilities.map(f => f.FacilityID);
}

function getNumberOfPersons(reservation) {
    if (reservation.NumberOfPersons) return parseInt(reservation.NumberOfPersons);
    if (reservation.NumberOfPersonsText) {
        const parsed = parseInt(reservation.NumberOfPersonsText);
        if (!isNaN(parsed)) return parsed;
    }
    return 1;
}

function getChildCounts(reservation) {
    let kids = 0;
    let babies = 0;
    if (reservation.ReservationProducts && Array.isArray(reservation.ReservationProducts)) {
        reservation.ReservationProducts.forEach(p => {
            const name = (p.Name || '').toLowerCase();
            const num = parseInt(p.NumberOf) || 0;
            if (name.includes('kind 4 t/m 11 jr')) kids = Math.max(kids, num);
            else if (name.includes('kind 0 t/m 3 jr')) babies = Math.max(babies, num);
        });
    }
    return { kids, babies };
}

function isTourDeThorn(reservation) {
    if (!reservation.ReservationCodings || !Array.isArray(reservation.ReservationCodings)) {
        return false;
    }
    return reservation.ReservationCodings.some(c => c.ReservationCodingChoiceID === 90);
}

module.exports = {
    getReservations,
    getReservation,
    validateReservation,
    getFacilityIds,
    getNumberOfPersons,
    getChildCounts,
    isTourDeThorn
};
