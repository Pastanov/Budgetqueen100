const express = require('express');
const axios = require('axios'); // תוסף שעוזר לשרת לשלוח הודעות החוצה
const app = express();
app.use(express.json());

// אימות מול מטא (נשאר אותו דבר)
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode && token) {
        if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
            res.status(200).send(challenge);
        } else {
            res.sendStatus(403);
        }
    }
});

// החלק החדש: קבלת הודעה מוואטסאפ ושליחת תשובה
app.post('/webhook', async (req, res) => {
    try {
        // בודק אם זו הודעה אמיתית שיש בה טקסט
        if (req.body.object && req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]) {
            
            const messageData = req.body.entry[0].changes[0].value.messages[0];
            const fromNumber = messageData.from; // מספר הטלפון של מי ששלח
            const textReceived = messageData.text.body; // מה שהוא כתב

            console.log(`התקבלה הודעה מ-${fromNumber}: ${textReceived}`);

            // שליחת הודעה חזרה למשתמש
            await axios.post(`https://graph.facebook.com/v18.0/${process.env.PHONE_NUMBER_ID}/messages`, {
                messaging_product: "whatsapp",
                to: fromNumber,
                type: "text",
                text: { body: `היי! שמעתי אותך. כתבת לי: "${textReceived}". בקרוב אדע גם לנהל לך את התקציב!` }
            }, {
                headers: { 'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}` }
            });
        }
        res.sendStatus(200);
    } catch (error) {
        console.error("שגיאה בטיפול בהודעה:", error.response?.data || error.message);
        res.sendStatus(500);
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`השרת רץ`));
