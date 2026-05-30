const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-client');

const app = express();
app.use(express.json());

// חיבור ל-Supabase באמצעות המשתנים שהגדרנו ב-Render
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// שערים כגיבוי (אם ה-API החי לא עובד)
const DEFAULT_RATES = { ILS: 1.0, USD: 3.7, EUR: 4.0 };
const CURRENCY_SYMBOLS = { ILS: '₪', USD: '$', EUR: '€' };

// מנגנון הבאת שערים חיים (מט"ח)
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

// אימות ה-Webhook מול מטא (קורה רק פעם אחת בחיבור)
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

        // בדיקה שמדובר בהודעת וואטסאפ רגילה
        if (body.object === 'whatsapp_business_account' && body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]) {
            const msg = body.entry[0].changes[0].value.messages[0];
            const fromNumber = msg.from; // מספר הוואטסאפ של המשתמש
            
            if (msg.type !== 'text') return res.sendStatus(200);
            const textRaw = msg.text.body.trim();
            const textLower = textRaw.toLowerCase();

            // 1. שליפת מצב המשתמש מ-Supabase (או יצירת משתמש חדש אם הוא לא קיים)
            let { data: user, error: userError } = await supabase
                .from('user_budgets')
                .select('*')
                .eq('phone_number', fromNumber)
                .single();

            if (!user) {
                const { data: newUser, error: createError } = await supabase
                    .from('user_budgets')
                    .insert([{ phone_number: fromNumber, budget: 0, remaining: 0, display_currency: 'ILS' }])
                    .select()
                    .single();
                user = newUser;
            }

            let replyText = "לא בטוחה שהבנתי 🫣\nדוגמאות: 💰 תקציב 3000 | 🍕 20$ פיצה | 📊 סיכום | 🔄 איפוס";

            // === פקודת איפוס ===
            if (['איפוס', 'reset', 'start'].includes(textLower)) {
                await supabase.from('expenses').delete().eq('phone_number', fromNumber);
                await supabase.from('user_budgets').update({ budget: 0, remaining: 0 }).eq('phone_number', fromNumber);
                replyText = "🔄 אופסנו הכול! איזה כיף להתחיל נקי ✨\nכתבי למשל: 'תקציב 3000' כדי להתחיל.";
            }
            
            // === פקודת הגדרת תקציב ===
            else if (textLower.startsWith('תקציב')) {
                const numberMatch = textRaw.match(/(\d[\d,.]*)/);
                if (numberMatch) {
                    const amount = parseFloat(numberMatch[1].replace(/,/g, ''));
                    const currency = detectCurrency(textRaw, user.display_currency);
                    const rates = await fetchLiveRates();
                    
                    // המרה לשקלים לצורך שמירה בבסיס הנתונים
                    const amountIls = amount * (rates[currency] || 1);

                    await supabase.from('expenses').delete().eq('phone_number', fromNumber); // מוחק הוצאות קודמות
                    await supabase.from('user_budgets').update({ 
                        budget: amountIls, 
                        remaining: amountIls,
                        display_currency: currency 
                    }).eq('phone_number', fromNumber);

                    replyText = `💰 הוגדר תקציב חדש: ${formatCurrency(amount, currency)}.\nנשאר לך: ${formatCurrency(amount, currency)}`;
                } else {
                    replyText = "לא הבנתי את הסכום 😅 נסי: 'תקציב 3000' או 'תקציב 1500$'";
                }
            }

            // === פקודת סיכום ===
            else if (['סיכום', 'הוצאות'].includes(textLower)) {
                const { data: expenses } = await supabase.from('expenses').select('*').eq('phone_number', fromNumber).order('created_at', { ascending: true });
                
                if (!expenses || expenses.length === 0) {
                    replyText = `עדיין לא נרשמו הוצאות.\nיתרה: ${formatCurrency(user.remaining, user.display_currency)}`;
                } else {
                    const rates = await fetchLiveRates();
                    const userRate = rates[user.display_currency] || 1;

                    let listLines = expenses.map((exp, i) => {
                        const originalAmountFormatted = formatCurrency(exp.amount_original, exp.currency_original);
                        return `${i + 1}. ${originalAmountFormatted} – ${exp.description}`;
                    });

                    const totalInUserCurrency = (user.budget - user.remaining) / userRate;
                    const remainingInUserCurrency = user.remaining / userRate;
                    const budgetInUserCurrency = user.budget / userRate;

                    replyText = `📊 *סיכום חמוד:*\n${listLines.join('\n')}\n\n` +
                                `סה"כ הוצאות: ${formatCurrency(totalInUserCurrency, user.display_currency)}\n` +
                                `יתרה: ${formatCurrency(remainingInUserCurrency, user.display_currency)}\n` +
                                `תקציב: ${formatCurrency(budgetInUserCurrency, user.display_currency)}`;
                    
                    if (remainingInUserCurrency < 0) {
                        replyText += `\n⚠️ שימי לב, את במינוס של ${formatCurrency(Math.abs(remainingInUserCurrency), user.display_currency)}!`;
                    }
                }
            }

            // === פקודת הוספת הוצאה (אם המשפט מכיל מספר) ===
            else if (/\d/.test(textRaw)) {
                if (user.budget === 0) {
                    replyText = "📝 קודם מגדירות תקציב, סיס! נסי: 'תקציב 3000' או 'תקציב 500$'";
                } else {
                    const numberMatch = textRaw.match(/(\d[\d,.]*)/);
                    if (numberMatch) {
                        const amountOriginal = parseFloat(numberMatch[1].replace(/,/g, ''));
                        const currencyOriginal = detectCurrency(textRaw, user.display_currency);
                        const rates = await fetchLiveRates();
                        
                        const amountIls = amountOriginal * (rates[currencyOriginal] || 1);
                        
                        // ניקוי הטקסט כדי להבין מה התיאור (מוריד את המספר והמטבע)
                        let description = textRaw.replace(numberMatch[0], '').replace(/(דולר|יורו|אירו|שקל|ש"ח|₪|\$|€)/g, '').trim();
                        if (!description) description = 'הוצאה כללית';

                        // שמירת ההוצאה ב-Supabase
                        await supabase.from('expenses').insert([{
                            phone_number: fromNumber,
                            amount_ils: amountIls,
                            amount_original: amountOriginal,
                            currency_original: currencyOriginal,
                            description: description
                        }]);

                        // עדכון היתרה החדשה
                        const newRemaining = user.remaining - amountIls;
                        await supabase.from('user_budgets').update({ remaining: newRemaining }).eq('phone_number', fromNumber);

                        const userRate = rates[user.display_currency] || 1;
                        const remainingInUserCurrency = newRemaining / userRate;

                        replyText = `➕ נוספה הוצאה: ${formatCurrency(amountOriginal, currencyOriginal)} עבור "${description}".\n` +
                                    `נשאר בתקציב: ${formatCurrency(remainingInUserCurrency, user.display_currency)}`;
                        
                        if (remainingInUserCurrency < 0) {
                            replyText += ` ⚠️ (את במינוס)`;
                        }
                    }
                }
            }

            // שליחת התשובה חזרה למשתמש בוואטסאפ באמצעות ה-API של מטא
            const whatsappToken = process.env.WHATSAPP_TOKEN; 
            const phoneId = body.entry[0].changes[0].value.metadata.phone_number_id;

            await axios.post(`https://graph.facebook.com/v17.0/${phoneId}/messages`, {
                messaging_product: 'whatsapp',
                to: fromNumber,
                type: 'text',
                text: { body: replyText }
            }, {
                headers: { 'Authorization': `Bearer ${whatsappToken}` }
            });
        }

        res.sendStatus(200);
    } catch (error) {
        console.error('Error handling webhook:', error.response?.data || error.message);
        res.sendStatus(200); // מחזירים 200 למטא כדי שלא יחסמו את השרת שלנו במקרה של שגיאה
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
