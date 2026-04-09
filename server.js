const express = require('express');
const path = require('path');
const dgram = require('dgram');
const { AccessToken, RoomServiceClient } = require('livekit-server-sdk');

// UDP client for TouchDesigner slider forwarding
const udpClient = dgram.createSocket('udp4');
const TD_SLIDER_PORT = 8021;
const TD_SLIDER_HOST = '127.0.0.1';
// Stripe payment integration enabled - Dec 7, 2025

const app = express();
const PORT = process.env.PORT || 3000;

const LIVEKIT_API_KEY = 'APITw2Yp2Tv3yfg';
const LIVEKIT_API_SECRET = 'eVYY0UB69XDGLiGzclYuGUhXuVpc8ry3YcazimFryDW';
const LIVEKIT_URL = 'wss://claymation-transcription-l6e51sws.livekit.cloud';
const LIVEKIT_API_URL = 'https://claymation-transcription-l6e51sws.livekit.cloud';

const roomService = new RoomServiceClient(LIVEKIT_API_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);

// Stripe configuration
const STRIPE_PUBLISHABLE_KEY = process.env.STRIPE_PUBLISHABLE_KEY || '';
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const stripe = STRIPE_SECRET_KEY ? require('stripe')(STRIPE_SECRET_KEY) : null;

app.use(express.json());
app.use(express.static(__dirname));

// ============================================
// ROOM STATUS - Check if room is available
// ============================================
app.get('/api/room-status', async (req, res) => {
    const room = req.query.room || 'claymation-live';
    try {
        const participants = await roomService.listParticipants(room);
        // Count mirror-users (the actual participants, not transcriber/viewer/obs)
        const mirrorUsers = participants.filter(p => 
            p.identity.startsWith('mirror-user')
        );
        res.json({
            room,
            mirrorUserCount: mirrorUsers.length,
            available: mirrorUsers.length === 0,
            allParticipants: participants.map(p => p.identity)
        });
    } catch (error) {
        // Room doesn't exist = available
        if (error.message && error.message.includes('not found')) {
            res.json({ room, mirrorUserCount: 0, available: true, allParticipants: [] });
        } else {
            console.error('Room status error:', error);
            res.status(500).json({ error: error.message });
        }
    }
});

// ============================================
// PUBLISHER TOKEN - ONE USER LIMIT ENFORCED
// ============================================
app.get('/api/publisher-token', async (req, res) => {
    try {
        // CHECK if someone is already connected - BLOCK if so
        try {
            const participants = await roomService.listParticipants('claymation-live');
            const mirrorUsers = participants.filter(p => p.identity.startsWith('mirror-user'));
            
            if (mirrorUsers.length > 0) {
                console.log('BLOCKED: Room occupied by', mirrorUsers.map(p => p.identity));
                return res.status(409).json({ 
                    error: 'Room occupied',
                    message: 'Another viewer is experiencing the installation.',
                    occupants: mirrorUsers.map(p => p.identity)
                });
            }
        } catch (e) {
            // Room doesn't exist = available, continue
        }

        // Generate unique identity for this session
        const identity = 'mirror-user-' + Date.now();
        
        const token = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
            identity,
            ttl: '24h'  // Festival-grade: full day coverage
        });
        token.addGrant({ 
            room: 'claymation-live', 
            roomJoin: true, 
            canPublish: true, 
            canSubscribe: false 
        });
        
        console.log('Issued publisher token for', identity);
        res.json({ 
            token: await token.toJwt(), 
            url: LIVEKIT_URL, 
            room: 'claymation-live', 
            identity 
        });
    } catch (e) { 
        console.error('Publisher token error:', e);
        res.status(500).json({ error: e.message }); 
    }
});

// ============================================
// FORCE DISCONNECT - Server-side kick
// ============================================
app.post('/api/disconnect', async (req, res) => {
    const { identity } = req.body;
    if (!identity) {
        return res.status(400).json({ error: 'identity required' });
    }
    try {
        await roomService.removeParticipant('claymation-live', identity);
        console.log('Force disconnected:', identity);
        res.json({ success: true, disconnected: identity });
    } catch (error) {
        // Already disconnected is fine
        console.log('Disconnect (may already be gone):', identity, error.message);
        res.json({ success: true, disconnected: identity, note: 'may have already left' });
    }
});

// ============================================
// VIEWER TOKENS
// ============================================

// Viewer token for TD (subscribes to claymation-live)
app.get('/api/viewer-token', async (req, res) => {
    const identity = 'viewer-td';
    try {
        const token = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, { identity, ttl: '24h' });
        token.addGrant({ room: 'claymation-live', roomJoin: true, canPublish: false, canSubscribe: true });
        res.json({ token: await token.toJwt(), url: LIVEKIT_URL, room: 'claymation-live' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Processed viewer token (subscribes to processed-output)
app.get('/api/processed-viewer-token', async (req, res) => {
    const identity = 'mirror-viewer-' + Date.now();
    try {
        const token = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, { identity, ttl: '24h' });
        token.addGrant({ room: 'processed-output', roomJoin: true, canPublish: false, canSubscribe: true });
        res.json({ token: await token.toJwt(), url: LIVEKIT_URL, room: 'processed-output', identity });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Processed publisher token (for OBS WHIP)
app.get('/api/processed-publisher-token', async (req, res) => {
    const identity = 'obs-whip-publisher';
    try {
        const token = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, { identity, ttl: '24h' });
        token.addGrant({ room: 'processed-output', roomJoin: true, canPublish: true, canSubscribe: false });
        const jwt = await token.toJwt();
        res.json({ 
            token: jwt, 
            url: LIVEKIT_URL, 
            room: 'processed-output',
            whipUrl: `https://claymation-transcription-l6e51sws.livekit.cloud/whip?access_token=${jwt}`
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Legacy /token endpoint
app.get('/token', async (req, res) => {
    const roomName = req.query.room || 'claymation-live';
    const identity = req.query.identity || 'user-' + Math.random().toString(36).substr(2, 6);
    const isPublisher = req.query.publisher === 'true';
    
    try {
        const token = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
            identity: identity,
            ttl: '6h'
        });
        
        token.addGrant({
            room: roomName,
            roomJoin: true,
            canPublish: isPublisher,
            canSubscribe: !isPublisher
        });
        
        const jwt = await token.toJwt();
        res.json({ token: jwt, url: LIVEKIT_URL, room: roomName, identity: identity });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// OBS WHIP token
app.get('/obs-whip-token', async (req, res) => {
    const roomName = req.query.room || 'claymation-live';
    const streamName = req.query.stream || 'obs-processed';
    
    try {
        const token = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
            identity: streamName,
            ttl: '24h'
        });
        
        token.addGrant({
            room: roomName,
            roomJoin: true,
            canPublish: true,
            canSubscribe: false
        });
        
        const jwt = await token.toJwt();
        const whipUrl = 'https://claymation-transcription-l6e51sws.livekit.cloud/w';
        
        res.json({
            whip_url: whipUrl,
            bearer_token: jwt,
            room: roomName,
            stream_name: streamName
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// SLIDER STATE & FORWARDING TO TOUCHDESIGNER
// ============================================
let currentSliders = {hue:280, sat:85, val:50, sz:50, spd:10, glw:60, temp:1, bump:50, depth:50, gloss:50, emboss:50, halo:50, shimmer:50, opacity:50, velocity:50, photorealism:50};

// POST - browser sends slider updates
app.post('/api/sliders', (req, res) => {
    currentSliders = {...currentSliders, ...req.body};
    
    // Also try UDP for local development
    const message = JSON.stringify(currentSliders);
    const buffer = Buffer.from(message);
    udpClient.send(buffer, 0, buffer.length, TD_SLIDER_PORT, TD_SLIDER_HOST, () => {});
    
    res.json({ success: true, sliders: currentSliders });
});

// GET - TouchDesigner polls for current state
app.get('/api/sliders', (req, res) => {
    res.json(currentSliders);
});

// Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'mirrors-echo-fixed.html'));
});

// Stripe endpoints
app.get('/api/stripe-config', (req, res) => {
    if (!STRIPE_PUBLISHABLE_KEY) {
        return res.status(503).json({ error: 'Stripe not configured' });
    }
    res.json({ publishableKey: STRIPE_PUBLISHABLE_KEY });
});

app.post('/api/create-checkout-session', async (req, res) => {
    if (!stripe) {
        return res.status(503).json({ error: 'Payment system not configured. Please contact kristabluedoor@gmail.com' });
    }
    
    try {
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [{
                price_data: {
                    currency: 'usd',
                    product_data: {
                        name: 'The Mirror\'s Echo - Exhibition License',
                        description: 'Unlimited sustained experience, commercial exhibition rights',
                    },
                    unit_amount: 40000,
                },
                quantity: 1,
            }],
            mode: 'payment',
            success_url: `${req.protocol}://${req.get('host')}/licensing.html?success=true`,
            cancel_url: `${req.protocol}://${req.get('host')}/licensing.html?canceled=true`,
        });
        
        res.json({ sessionId: session.id });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Health check
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
    console.log(`The Mirror's Echo running on port ${PORT}`);
    console.log('One-user limit ENFORCED - server will block if room occupied');
});
// force rebuild 1775762666
