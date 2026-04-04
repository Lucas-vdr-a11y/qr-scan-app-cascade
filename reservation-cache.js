const semApi = require('./sem-api');

const REFRESH_MINUTES = parseInt(process.env.CACHE_REFRESH_MINUTES) || 5;
const IDLE_MINUTES = parseInt(process.env.CACHE_IDLE_MINUTES) || 30;

let _cache = new Map();
let _date = null;
let _lastRefresh = null;
let _lastActivity = null;
let _refreshing = false;

function touch() {
    _lastActivity = Date.now();
}

function getCurrentDate() {
    return new Date().toISOString().split('T')[0];
}

function get(reservationId) {
    const wasIdle = isIdle();
    touch();
    if (wasIdle && _lastRefresh) refresh(); // achtergrond-refresh na idle
    return _cache.get(parseInt(reservationId)) || null;
}

function getAll() {
    const wasIdle = isIdle();
    touch();
    if (wasIdle && _lastRefresh) refresh(); // achtergrond-refresh na idle
    if (!_date || _date !== getCurrentDate()) return null;
    return Array.from(_cache.values());
}

function set(reservationId, reservation) {
    _cache.set(parseInt(reservationId), reservation);
}

async function refresh() {
    if (_refreshing) return;
    _refreshing = true;
    try {
        const date = getCurrentDate();
        if (date !== _date) _cache.clear();
        const reservations = await semApi.getReservations(date);
        _cache.clear();
        for (const r of reservations) {
            if (r.ReservationID) _cache.set(r.ReservationID, r);
        }
        _date = date;
        _lastRefresh = new Date();
        console.log(`✓ Cache refreshed: ${reservations.length} reserveringen voor ${date}`);
    } catch (error) {
        console.warn('⚠ Cache refresh mislukt (SEM onbereikbaar?):', error.message);
    } finally {
        _refreshing = false;
    }
}

function getMetadata() {
    return {
        date: _date,
        lastRefresh: _lastRefresh?.toISOString() || null,
        count: _cache.size,
        ageSeconds: _lastRefresh ? Math.round((Date.now() - _lastRefresh.getTime()) / 1000) : null,
        refreshMinutes: REFRESH_MINUTES,
        idle: isIdle(),
        idleMinutes: IDLE_MINUTES,
    };
}

function clear() {
    _cache.clear();
    _date = null;
    _lastRefresh = null;
}

function isIdle() {
    if (!_lastActivity) return true;
    return (Date.now() - _lastActivity) > IDLE_MINUTES * 60 * 1000;
}

function startAutoRefresh() {
    setInterval(() => {
        if (isIdle()) return;
        refresh();
    }, REFRESH_MINUTES * 60 * 1000);
}

module.exports = { get, getAll, set, refresh, getMetadata, clear, startAutoRefresh, touch };
