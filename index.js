const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys')
const express = require('express')
const axios = require('axios')
const QRCode = require('qrcode')
const pino = require('pino')

const app = express()
app.use(express.json())

const PORT = process.env.PORT || 3000
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || ''

let sock = null
let qrCodeData = null
let connectionStatus = 'disconnected'
let reconnectAttempts = 0

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info')
  const { version } = await fetchLatestBaileysVersion()

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: ['NuxIA', 'Chrome', '1.0.0'],
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
    keepAliveIntervalMs: 10000,
  })

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      try {
        qrCodeData = await QRCode.toDataURL(qr)
        connectionStatus = 'qr_ready'
        reconnectAttempts = 0
        console.log('QR Code listo')
      } catch (err) {
        console.error('Error generando QR:', err.message)
      }
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut
      console.log('Conexión cerrada. Código:', statusCode, 'Reconectar:', shouldReconnect)
      connectionStatus = 'disconnected'
      
      if (shouldReconnect && reconnectAttempts < 5) {
        reconnectAttempts++
        const delay = Math.min(5000 * reconnectAttempts, 30000)
        console.log(`Reconectando en ${delay/1000}s... (intento ${reconnectAttempts})`)
        setTimeout(connectToWhatsApp, delay)
      }
    }

    if (connection === 'open') {
      console.log('WhatsApp conectado exitosamente')
      connectionStatus = 'connected'
      qrCodeData = null
      reconnectAttempts = 0
    }
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return
    
    for (const msg of messages) {
      if (msg.key.fromMe) continue
      if (!msg.message) continue

      const from = msg.key.remoteJid
      if (from.includes('status@broadcast')) continue

      const text = msg.message?.conversation || 
                   msg.message?.extendedTextMessage?.text || 
                   msg.message?.imageMessage?.caption ||
                   ''

      if (!text) continue

      console.log(`Mensaje de ${from}: ${text}`)

      if (N8N_WEBHOOK_URL) {
        try {
          await axios.post(N8N_WEBHOOK_URL, {
            from,
            message: text,
            timestamp: msg.messageTimestamp,
            pushName: msg.pushName || ''
          })
          console.log('Mensaje enviado a N8n')
        } catch (err) {
          console.error('Error enviando a N8n:', err.message)
        }
      }
    }
  })
}

app.get('/qr', (req, res) => {
  if (connectionStatus === 'connected') {
    return res.send(`
      <html><body style="text-align:center;font-family:sans-serif;background:#0c0c10;color:white;padding:40px">
        <h2>✅ WhatsApp conectado exitosamente</h2>
        <p>NuxIA está lista para recibir mensajes</p>
      </body></html>
    `)
  }
  if (!qrCodeData) {
    return res.send(`
      <html><body style="text-align:center;font-family:sans-serif;background:#0c0c10;color:white;padding:40px">
        <h2>⏳ Generando QR...</h2>
        <p>Estado: ${connectionStatus}</p>
        <p>Recargando automáticamente...</p>
        <script>setTimeout(()=>location.reload(), 4000)</script>
      </body></html>
    `)
  }
  res.send(`
    <html>
      <body style="text-align:center;font-family:sans-serif;background:#0c0c10;color:white;padding:40px">
        <h2>📱 Escanea el QR con WhatsApp</h2>
        <p>Abre WhatsApp → Dispositivos vinculados → Vincular dispositivo</p>
        <img src="${qrCodeData}" style="width:300px;border-radius:12px;margin:20px auto;display:block"/>
        <p style="color:#c084fc">El QR se actualiza automáticamente</p>
        <script>setTimeout(()=>location.reload(), 20000)</script>
      </body>
    </html>
  `)
})

app.post('/send', async (req, res) => {
  const { to, message } = req.body
  if (!sock || connectionStatus !== 'connected') {
    return res.status(503).json({ error: 'WhatsApp no conectado', status: connectionStatus })
  }
  try {
    const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`
    await sock.sendMessage(jid, { text: message })
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.get('/status', (req, res) => {
  res.json({ status: connectionStatus, attempts: reconnectAttempts })
})

app.get('/', (req, res) => {
  res.json({ 
    service: 'NuxIA WhatsApp Bridge',
    status: connectionStatus,
    endpoints: { qr: '/qr', send: 'POST /send', status: '/status' }
  })
})

app.listen(PORT, () => {
  console.log(`NuxIA WhatsApp Bridge corriendo en puerto ${PORT}`)
  connectToWhatsApp()
})
