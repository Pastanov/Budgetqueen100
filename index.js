const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

// חיבור ל-Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// שערים כגיבוי
const DEFAULT_RATES = { ILS: 1.0, USD: 3.7, EUR: 4.0 };
const CURRENCY_SYMBOLS = { ILS: '₪', USD: '$', EUR: '€' };

// מנגנון הבאת שערים חיים עבור פקודת ההמרה המפורשת
async function fetchLiveRates() {
    try {
        const usdResp = await axios.get('https://api.frankfurter.app/latest?from=USD&to=ILS', { timeout: 2000 });
        const eurResp = await axios.get('https://api.frankfurter.app/latest?from=EUR&to=ILS', { timeout: 2000 });
        
        return {
            ILS: 1.0,
            USD: usdResp.data.rates.ILS || DEFAULT_RATES.USD,
            EUR: eurResp.data.rates.ILS || DEFAULT_RATES.EUR
        };
    } catch (error) {
        console.log('Error fetching live rates, using defaults:', error.message);
        return { ...DEFAULT_RATES };
    }
}

// זיהוי מטבע מתוך הטקסט
function detectCurrency(text, defaultCur) {
    const t = text.toLowerCase();
    if (t.includes('€') || t.includes('יורו') || t.includes('אירו') || t.includes('eur')) return 'EUR';
    if (t.includes('$') || t.includes('דולר') || t.includes('usd')) return 'USD';
    if (t.includes('₪') || t.includes('שח') || t.includes('ש"ח') || t.includes('שקל') || t.includes('ils')) return 'ILS';
    return defaultCur;
}

// פונקציית עזר לעיצוב סכום עם סימן מטבע
function formatCurrency(amount, currency) {
    const symbol = CURRENCY_SYMBOLS[currency] || '';
    return currency === 'ILS' ? `${Math.round(amount)} ${symbol}` : `${symbol}${Math.round(amount)}`;
}

// תיוג קטגוריות אוטומטי
function autoCategory(description) {
    const desc = description.toLowerCase();
    if (/(סושי|פיצה|קפה|מסעדה|אוכל|בורגר|שוקולד|סופר|מכולת|חלב|לחם|גלידה|בר|בירה|יין)/.test(desc)) return '🍔 אוכל וסטארבקס';
    if (/(מונית|גט|אובר|דלק|רכבת|אוטובוס|חניה|פנגו|טסלה|טיסה|מלון)/.test(desc)) return '🚗 תחבורה וטיולים';
    if (/(זארה|שיין|בגדים|נעליים|אסוס|קניון|חולצה|אמזון|עליאקספרס)/.test(desc)) return '🛍️ שופינג וביזבוזים';
    if (/(סרט|הופעה|מסיבה|פאב|בר|כרטיס|מוזיאון|באד באני|בילוים)/.test(desc)) return '🎉 כיף ובילויים';
    if (/(ביט|החזר|חבר|מתנה|זיכוי)/.test(desc)) return '💰 החזרים ומתנות';
    return '📝 כללי';
}

// מד התקדמות ויזואלי
function generateProgressBar(remaining, budget) {
    if (budget <= 0) return '';
    const pct = Math.max(0, Math.min(100, (remaining / budget) * 100));
    const totalBlocks = 10;
    const greenBlocks = Math.round((pct / 100) * totalBlocks);
    const whiteBlocks = totalBlocks - greenBlocks;
    
    let bar = '🟩'.repeat(greenBlocks) + '⬜'.repeat(whiteBlocks);
    if (pct <= 20) {
        bar = '🟥'.repeat(greenBlocks) + '⬜'.repeat(whiteBlocks);
    }
    return `${bar} (${Math.round(pct)}% נותר)`;
}

// אימות ה-Webhook מול מטא
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode && token) {
        if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
            console.log('WEBHOOK_VERIFIED');
            return res.status(200).send(challenge);
        }
        return res.sendStatus(403);
    }
});

// קבלת הודעות וואטסאפ וניהול התקציב
app.post('/webhook', async (req, res) => {
    try {
        const body = req.body;

        if (body.object === 'whatsapp_business_account' && body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]) {
            const msg = body.entry[0].changes[0].value.messages[0];
            const fromNumber = msg.from;
            
            if (msg.type !== 'text') return res.sendStatus(200);
            const textRaw = msg.text.body.trim();
            const textLower = textRaw.toLowerCase();

            // שליפת מצב המשתמש מ-Supabase
            let { data: user, error: userError } = await supabase
                .from('user_budgets')
                .select('*')
                .eq('phone_number', fromNumber)
                .single();

            if (!user) {
                const { data: newUser } = await supabase
                    .from('user_budgets')
                    .insert([{ phone_number: fromNumber, budget: 0, remaining: 0, display_currency: 'ILS' }])
                    .select()
                    .single();
                user = newUser;
            }

            let replyText = "לא בטוחה שהבנתי 🫣\nכתבו 'היי' כדי לקבל את רשימת הפקודות המלאה!";

            // === 1. פקודת המרה חכמה ומפורשת (מחשבון מט"ח לפי דרישה בלבד) ===
            if (textLower.includes('כמה זה') || textLower.includes('בשקלים') || textLower.includes('לשקל') || textLower.includes('בדולרים') || textLower.includes('ביורו')) {
                const numberMatch = textRaw.match(/(\d[\d,.]*)/);
                if (numberMatch) {
                    const amount = parseFloat(numberMatch[1].replace(/,/g, ''));
                    const rates = await fetchLiveRates();
                    
                    let fromCurrency = detectCurrency(textRaw, 'USD'); 
                    let targetCurrency = textRaw.includes('בשקלים') || textRaw.includes('לשקל') ? 'ILS' : detectCurrency(textRaw, 'ILS');

                    // אם המשתמש שאל למשל "כמה זה 50 שקל בדולרים"
                    if ((textRaw.includes('שקל') || textRaw.includes('שח') || textRaw.includes('₪')) && !textRaw.startsWith('כמה זה שקל')) {
                        fromCurrency = 'ILS';
                    }

                    if (fromCurrency === 'USD' && targetCurrency === 'ILS') {
                        const result = amount * rates.USD;
                        replyText = `🧮 *מחשבון המרה:* \n${formatCurrency(amount, 'USD')} שווים כיום ל-*${formatCurrency(result, 'ILS')}*.`;
                    } else if (fromCurrency === 'EUR' && targetCurrency === 'ILS') {
                        const result = amount * rates.EUR;
                        replyText = `🧮 *מחשבון המרה:* \n${formatCurrency(amount, 'EUR')} שווים כיום ל-*${formatCurrency(result, 'ILS')}*.`;
                    } else if (fromCurrency === 'ILS' && targetCurrency === 'USD') {
                        const result = amount / rates.USD;
                        replyText = `🧮 *מחשבון המרה:* \n${formatCurrency(amount, 'ILS')} שווים כיום ל-*${formatCurrency(result, 'USD')}*.`;
                    } else if (fromCurrency === 'ILS' && targetCurrency === 'EUR') {
                        const result = amount / rates.EUR;
                        replyText = `🧮 *מחשבון המרה:* \n${formatCurrency(amount, 'ILS')} שווים כיום ל-*${formatCurrency(result, 'EUR')}*.`;
                    } else {
                        replyText = `לא הצלחתי לחשב את ההמרה המדויקת 🤯 נסו: "כמה זה 100 דולר בשקלים" או "כמה זה 250 שח ביורו".`;
                    }
                } else {
                    replyText = `כדי להשתמש במחשבון, אנא ציינו מספר. למשל: "כמה זה 50 דולר בשקלים?".`;
                }
            }

            // === 2. פקודת ברכה והסבר ===
            else if (['הי', 'היי', 'שלום', 'הלו', 'היוש', 'start', 'help', 'עזרה'].some(v => textLower.startsWith(v))) {
                replyText = `👋 *היי ברוכים הבאים!* \n` +
                            `אני ה-*Budget Queen* 👑 ואני כאן כדי לעזור לכם לנהל את התקציב שלכם ישירות מהוואטסאפ!\n\n` +
                            `*איך זה עובד?* 💸\n\n` +
                            `1️⃣ *הגדרת תקציב:* \n` +
                            `💡 כתבו: \`תקציב 200$\` או \`תקציב 3000\`. הבוט ינהל את הכל לפי המטבע שהגדרתם!\n\n` +
                            `2️⃣ *תיעוד הוצאה:* פשוט כתבו סכום ומה קניתם. \n` +
                            `💡 נסו: \`50 מונית\` או \`12 קפה\`. (הבוט מפחית מהתקציב 1 ל-1 ללא המרות אוטומטיות).\n` +
                            `💡 אם קיבלתם החזר כספי, כתבו מינוס: \`-100 ביט מחבר\`.\n\n` +
                            `3️⃣ *בדיקת מצב:* \n` +
                            `💡 כתבו: \`סיכום\` ותקבלו פירוט מלא ומד התקדמות.\n\n` +
                            `4️⃣ *מחשבון המרה חי (חדש!):* \n` +
                            `💡 רוצים לדעת שערים בלי קשר לתקציב? שאלו אותי: \`כמה זה 100 דולר בשקלים?\` 🧮\n\n` +
                            `5️⃣ *טעיתם בהקלדה?* כתבו \`מחיקה\`. לחודש חדש? כתבו \`איפוס\`.`;
            }
            
            // === 3. פקוד
