const express = require('express');
const app = express();
app.use(express.json());

// שלב האימות מול מטא
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    // כאן השרת בודק אם מטא שלחה את הסיסמה הנכונה
    if (mode && token) {
        if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
            console.log('האימות הצליח!');
            res.status(200).send(challenge);
        } else {
            res.sendStatus(403);
        }
    }
});

// החלק שמקשיב להודעות (נרחיב אותו בהמשך)
app.post('/webhook', (req, res) => {
    res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`השרת עובד על פורט ${PORT}`));
