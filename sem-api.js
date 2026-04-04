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
                DoLoadReservationCodings: true,
                TotalPriceLoadOptions: {
                    DoIncludeAdditionalCosts: true,
                    DoIncludeDiscounts: true,
                    DoIncludeSales: true
                },
                OpenAmountLoadOptions: {
                    DoIncludeSalePayments: true
                }
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
                DoLoadReservationCodings: true,
                TotalPriceLoadOptions: {
                    DoIncludeAdditionalCosts: true,
                    DoIncludeDiscounts: true,
                    DoIncludeSales: true
                },
                OpenAmountLoadOptions: {
                    DoIncludeSalePayments: true
                }
            }
        });

        return response.data.Reservation;
    } catch (error) {
        console.error(`Error fetching reservation ${reservationId}:`, error.message);
        throw new Error('Failed to fetch reservation from SEM API');
    }
}

/**
 * Registreer een betaling bij SEM
 */
async function addReservationPayment(reservationId, paymentAmount) {
    try {
        const response = await semClient.post('/api/Reservations/AddReservationPayments', {
            ReservationID: parseInt(reservationId),
            ReservationPayments: [{
                ReservationID: parseInt(reservationId),
                PaymentAmount: parseFloat(paymentAmount),
                PaymentRegisterID: parseInt(process.env.SEM_PAYMENT_REGISTER_ID || '1')
            }]
        });
        return response.data;
    } catch (error) {
        console.error(`Error adding payment for reservation ${reservationId}:`, error.message);
        throw new Error('Failed to add payment via SEM API');
    }
}

/**
 * Haal financiele informatie op uit een reservering
 */
function getFinanceInfo(reservation) {
    const openAmount = (reservation.OpenAmount !== null && reservation.OpenAmount !== undefined)
        ? parseFloat(reservation.OpenAmount) : null;

    let totalPrice = reservation.TotalPriceIn || 0;
    if (totalPrice === 0 && reservation.ReservationProducts) {
        totalPrice = reservation.ReservationProducts.reduce((sum, p) => sum + (p.PriceIn || 0), 0);
    }

    if (reservation.ReservationDiscounts && Array.isArray(reservation.ReservationDiscounts)) {
        const totalDiscount = reservation.ReservationDiscounts.reduce((sum, d) => sum + (d.AmountIn || 0), 0);
        totalPrice -= totalDiscount;
    }

    let totalPaid = 0;
    if (reservation.ReservationPayments) {
        totalPaid = reservation.ReservationPayments.reduce((sum, p) => sum + (p.PaymentAmount || p.Amount || 0), 0);
    }

    const calculatedOpen = openAmount !== null ? openAmount : Math.max(0, totalPrice - totalPaid);
    const isPaid = calculatedOpen <= 0.01;

    return {
        total_price: Math.round(totalPrice * 100) / 100,
        total_paid: Math.round(totalPaid * 100) / 100,
        open_amount: Math.round(calculatedOpen * 100) / 100,
        is_paid: isPaid,
        products: (reservation.ReservationProducts || []).map(p => ({
            name: p.ProductName || p.Name || 'Product',
            quantity: p.NumberOf ?? 0,
            unit_price: p.PricePerUnitIn || 0,
            total_price: p.PriceIn || 0,
            type: p.OptionalType
        })),
        discounts: (reservation.ReservationDiscounts || []).map(d => ({
            name: d.DiscountName || d.Name || 'Korting',
            amount: d.AmountIn || 0,
            percentage: d.Percentage || null
        })),
        payments: (reservation.ReservationPayments || []).map(p => ({
            amount: p.PaymentAmount || p.Amount || 0,
            date: p.PaymentDate || null,
            description: p.Description || null
        })),
        // Bruto subtotaal (voor kortingen)
        subtotal: Math.round((reservation.ReservationProducts || []).reduce((sum, p) => sum + (p.PriceIn || 0), 0) * 100) / 100,
        total_discount: Math.round((reservation.ReservationDiscounts || []).reduce((sum, d) => sum + (d.AmountIn || 0), 0) * 100) / 100
    };
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
            return { valid: false, reason: 'NOT_PAID', openAmount: openAmount };
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
            return { valid: false, reason: 'NOT_PAID', openAmount: totalPrice - totalPaid };
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
    if (reservation.NumberOfPersons > 0) return parseInt(reservation.NumberOfPersons);
    if (reservation.NumberOfPersonsText) {
        // Handle ranges like "11-12" by taking the highest number
        const rangeMatch = reservation.NumberOfPersonsText.match(/(\d+)\s*[-–]\s*(\d+)/);
        if (rangeMatch) return Math.max(parseInt(rangeMatch[1]), parseInt(rangeMatch[2]));
        const parsed = parseInt(reservation.NumberOfPersonsText);
        if (!isNaN(parsed) && parsed > 0) return parsed;
    }
    // Fallback: sum from main products (highest NumberOf value)
    if (reservation.ReservationProducts && Array.isArray(reservation.ReservationProducts)) {
        const mainProducts = reservation.ReservationProducts.filter(p => p.OptionalType !== 'OptionalUnselected');
        if (mainProducts.length > 0) {
            const max = Math.max(...mainProducts.map(p => parseInt(p.NumberOf) || 0));
            if (max > 0) return max;
        }
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
    addReservationPayment,
    getFinanceInfo,
    validateReservation,
    getFacilityIds,
    getNumberOfPersons,
    getChildCounts,
    isTourDeThorn
};
