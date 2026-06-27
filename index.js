const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys')
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

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info')

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
    logger: pino({ level: 'silent' })
  })

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      qrCodeData = await QRCode.toDataURL(qr)
      connectionStatus = 'qr_ready'
      console.log('QR Code generado — visita /qr para escanearlo')
    }

    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut
      console.log('Conexión cerrada. Reconectando:', shouldReconnect)
      connectionStatus = 'disconnected'
      if (shouldReconnect) {
        setTimeout(connectToWhatsApp, 3000)
      }
    }

    if (connection === 'open') {
      console.log('WhatsApp conectado exitosamente')
      connectionStatus = 'connected'
      qrCodeData = null
    }
  })

  sock.ev.on('creds.update', saveCreds)

  // Recibir mensajes y reenviar a N8n
  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      if (msg.key.fromMe) continue
      if (!msg.message) continue

      const from = msg.key.remoteJid
      const text = msg.message?.conversation || 
                   msg.message?.extendedTextMessage?.text || 
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
        } catch (err) {
          console.error('Error enviando a N8n:', err.message)
        }
      }
    }
  })
}

// Endpoint para ver el QR
app.get('/qr', (req, res) => {
  if (connectionStatus === 'connected') {
    return res.send('<h2>✅ WhatsApp ya está conectado</h2>')
  }
  if (!qrCodeData) {
    return res.send('<h2>⏳ Generando QR... Recarga en 5 segundos</h2><script>setTimeout(()=>location.reload(),5000)</script>')
  }
  res.send(`
    <html>
      <body style="text-align:center;font-family:sans-serif;background:#0c0c10;color:white;padding:40px">
        <h2>📱 Escanea el QR con WhatsApp</h2>
        <p>Abre WhatsApp → Dispositivos vinculados → Vincular dispositivo</p>
        <img src="${qrCodeData}" style="width:300px;border-radius:12px"/>
        <p>La página se recarga automáticamente</p>
        <script>setTimeout(()=>location.reload(),15000)</script>
      </body>
    </html>
  `)
})

// Endpoint para enviar mensajes desde N8n
app.post('/send', async (req, res) => {
  const { to, message } = req.body
  if (!sock || connectionStatus !== 'connected') {
    return res.status(503).json({ error: 'WhatsApp no conectado' })
  }
  try {
    const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`
    await sock.sendMessage(jid, { text: message })
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Status
app.get('/status', (req, res) => {
  res.json({ status: connectionStatus })
})

app.get('/', (req, res) => {
  res.json({ 
    service: 'NuxIA WhatsApp Bridge',
    status: connectionStatus,
    qr: '/qr',
    send: 'POST /send'
  })
})

app.listen(PORT, () => {
  console.log(`NuxIA WhatsApp Bridge corriendo en puerto ${PORT}`)
  connectToWhatsApp()
})
