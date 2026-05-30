'use strict';

const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

// ─── Supabase ────────────────────────────────────────────────────────────────
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.error('FATAL: SUPABASE_URL and SUPABASE_KEY environment variables must be set.');
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

// ─── Constants ───────────────────────────────────────────────────────────────
const DEFAULT_RATES = { ILS: 1.0, USD: 3.7, EUR: 4.0 };
const CURRENCY_SYMBOLS = { ILS: '₪', USD: '$', EUR: '€' };

// ─── Live Rates (used ONLY by the explicit calculator command) ────────────────
async function fetchLiveRates() {
    try {
        const [usdResp, eurResp] = await Promise.all([
            axios.get('https://api.frankfurter.app/latest?from=USD&to=ILS', { timeout: 3000 }),
            axios.get('https://api.frankfurter.app/latest?from=EUR&to=ILS', { timeout: 3000 }),
        ]);
        return {
            ILS: 1.0,
            USD: usdResp.data?.rates?.ILS || DEFAULT_RATES.USD,
            EUR: eurResp.data?.rates?.ILS || DEFAULT_RATES.EUR,
        };
    } catch (err) {
        console.warn('fetchLiveRates: falling back to defaults –', err.message);
        return { ...DEFAULT_RATES };
    }
}

// ─── Currency Detection ───────────────────────────────────────────────────────
// Handles natural Hebrew plurals / variants + symbols + Latin codes.
function detectCurrency(text, defaultCur) {
    const t = text;

    // EUR — check before ILS/USD so "יורו" doesn't fall through
    if (/€|יורו|אירו|יורואים|אירואים|eur/i.test(t)) return 'EUR';

    // USD
    if (/\$|דולר|דולרים|usd/i.test(t)) return 'USD';

    // ILS
    if (/₪|שקל|שקלים|ש"ח|שח|ils/i.test(t)) return 'ILS';

    return defaultCur;
}

// ─── Formatting ───────────────────────────────────────────────────────────────
function formatCurrency(amount, currency) {
    const symbol = CURRENCY_SYMBOLS[currency] || '';
    const rounded = Math.round(amount);
    return currency === 'ILS' ? `${rounded} ${symbol}` : `${symbol}${rounded}`;
}

// ─── Auto-Category ────────────────────────────────────────────────────────────
function autoCategory(description) {
    const d = description.toLowerCase();
    if (/(סושי|פיצה|קפה|מסעדה|אוכל|בורגר|שוקולד|סופר|מכולת|חלב|לחם|גלידה|בר|בירה|יין)/.test(d)) return '🍔 אוכל וסטארבקס';
    if (/(מונית|גט|אובר|דלק|רכבת|אוטובוס|חניה|פנגו|טסלה|טיסה|מלון)/.test(d)) return '🚗 תחבורה וטיולים';
    if (/(זארה|שיין|בגדים|נעליים|אסוס|קניון|חולצה|אמזון|עליאקספרס)/.test(d)) return '🛍️ שופינג וביזבוזים';
    if (/(סרט|הופעה|מסיבה|פאב|בר|כרטיס|מוזיאון|באד באני|בילוים)/.test(d)) return '🎉 כיף ובילויים';
    if (/(ביט|החזר|חבר|מתנה|זיכוי)/.test(d)) return '💰 החזרים ומתנות';
    return '📝 כללי';
}

// ─── Progress Bar ─────────────────────────────────────────────────────────────
function generateProgressBar(remaining, budget) {
    if (!budget || budget <= 0) return '';
    const pct = Math.max(0, Math.min(100, (remaining / budget) * 100));
    const filled = Math.round((pct / 100) * 10);
    const empty = 10 - filled;
    const block = pct <= 20 ? '🟥' : '🟩';
    return `${block.repeat(filled)}${'⬜'.repeat(empty)} (${Math.round(pct)}% נותר)`;
}

// ─── Send WhatsApp message ────────────────────────────────────────────────────
// phoneId: extracted from webhook payload metadata; falls back to env var if missing.
async function sendWhatsApp(phoneId, to, body) {
    const token = process.env.WHATSAPP_TOKEN;
    if (!token) {
        console.error('sendWhatsApp: WHATSAPP_TOKEN is not set.');
        return;
    }

    // Prefer the live payload value; fall back to the env var as a safety net.
    const resolvedPhoneId = phoneId || process.env.WHATSAPP_PHONE_NUMBER_ID;
    if (!resolvedPhoneId) {
        console.error('sendWhatsApp: phone_number_id is missing from payload and WHATSAPP_PHONE_NUMBER_ID env var is not set.');
        return;
    }

    try {
        await axios.post(
            `https://graph.facebook.com/v21.0/${resolvedPhoneId}/messages`,
            { messaging_product: 'whatsapp', to, type: 'text', text: { body } },
            { headers: { Authorization: `Bearer ${token}` } }
        );
    } catch (err) {
        console.error('sendWhatsApp error:', err.response?.data || err.message);
    }
}

// ─── Safe Supabase wrapper ────────────────────────────────────────────────────
// Returns { data, error } — never throws; logs the error for visibility.
async function dbQuery(fn) {
    try {
        const result = await fn();
        if (result.error) {
            console.error('Supabase error:', result.error);
        }
        return result;
    } catch (err) {
        console.error('Unexpected DB error:', err.message);
        return { data: null, error: { message: err.message } };
    }
}

// ─── Ensure user row exists (handles first-time / empty table) ────────────────
async function getOrCreateUser(fromNumber) {
    const { data: existing, error: selectErr } = await dbQuery(() =>
        supabase.from('user_budgets').select('*').eq('phone_number', fromNumber).maybeSingle()
    );

    if (selectErr) return { user: null, dbError: selectErr.message };

    if (existing) return { user: existing, dbError: null };

    // New user — insert a fresh row
    const { data: created, error: insertErr } = await dbQuery(() =>
        supabase
            .from('user_budgets')
            .insert([{ phone_number: fromNumber, budget: 0, remaining: 0, display_currency: 'ILS' }])
            .select()
            .maybeSingle()
    );

    if (insertErr) return { user: null, dbError: insertErr.message };
    return { user: created, dbError: null };
}

// ─── Webhook verification ─────────────────────────────────────────────────────
app.get('/webhook', (req, res) => {
    const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
    if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
        console.log('WEBHOOK_VERIFIED');
        return res.status(200).send(challenge);
    }
    res.sendStatus(403);
});

// ─── Main webhook handler ─────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
    // Always acknowledge Meta immediately
    res.sendStatus(200);

    try {
        const body = req.body;
        const message = body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
        if (!message || body.object !== 'whatsapp_business_account') return;
        if (message.type !== 'text') return;

        const fromNumber = message.from;
        // Extract phone_number_id from Meta's metadata; fall back to env var as a safety net.
        // This must match the phone number registered in your Meta App Dashboard.
        const phoneId =
            body.entry[0].changes[0].value.metadata?.phone_number_id ||
            process.env.WHATSAPP_PHONE_NUMBER_ID;

        if (!phoneId) {
            console.error('Webhook: phone_number_id missing from payload and WHATSAPP_PHONE_NUMBER_ID env var not set.');
            return;
        }
        const textRaw = message.text.body.trim();
        const textLower = textRaw.toLowerCase();

        // Helper: send reply and log
        const reply = (text) => sendWhatsApp(phoneId, fromNumber, text);

        // ── Load / create user ────────────────────────────────────────────────
        const { user, dbError: userLoadError } = await getOrCreateUser(fromNumber);

        if (userLoadError || !user) {
            await reply(`⚠️ שגיאת מסד נתונים בטעינת הפרופיל שלכם:\n${userLoadError || 'unknown error'}\nנסו שוב בעוד כמה שניות.`);
            return;
        }

        // ── 1. Currency Calculator (explicit, live rates) ─────────────────────
        if (
            textLower.includes('כמה זה') ||
            textLower.includes('בשקלים') ||
            textLower.includes('לשקל') ||
            textLower.includes('בדולרים') ||
            textLower.includes('ביורו')
        ) {
            const numberMatch = textRaw.match(/(\d[\d,.]*)/);
            if (!numberMatch) {
                await reply('כדי להשתמש במחשבון, אנא ציינו מספר. למשל: "כמה זה 50 דולר בשקלים?".');
                return;
            }

            const amount = parseFloat(numberMatch[1].replace(/,/g, ''));
            const rates = await fetchLiveRates();

            // Determine source & target currencies
            const isTargetILS = textLower.includes('בשקלים') || textLower.includes('לשקל');
            const isTargetUSD = textLower.includes('בדולרים');
            const isTargetEUR = textLower.includes('ביורו');

            // Detect source from the rest of the text (minus the number)
            const textWithoutNum = textRaw.replace(numberMatch[0], '');
            let fromCurrency = detectCurrency(textWithoutNum, 'USD');

            // If no explicit source detected, try the whole string (user may write "100 דולר בשקלים")
            if (fromCurrency === 'USD' && !(/דולר|דולרים|\$|usd/i.test(textWithoutNum))) {
                fromCurrency = detectCurrency(textRaw, 'USD');
            }

            let targetCurrency = isTargetILS ? 'ILS' : isTargetUSD ? 'USD' : isTargetEUR ? 'EUR' : 'ILS';

            // If source and target are identical, flip
            if (fromCurrency === targetCurrency) {
                targetCurrency = targetCurrency === 'ILS' ? 'USD' : 'ILS';
            }

            let result;
            if (fromCurrency === 'USD' && targetCurrency === 'ILS') result = amount * rates.USD;
            else if (fromCurrency === 'EUR' && targetCurrency === 'ILS') result = amount * rates.EUR;
            else if (fromCurrency === 'ILS' && targetCurrency === 'USD') result = amount / rates.USD;
            else if (fromCurrency === 'ILS' && targetCurrency === 'EUR') result = amount / rates.EUR;
            else {
                await reply('לא הצלחתי לחשב את ההמרה 🤯 נסו: "כמה זה 100 דולר בשקלים" או "כמה זה 250 שקל ביורו".');
                return;
            }

            await reply(`🧮 *מחשבון המרה:*\n${formatCurrency(amount, fromCurrency)} שווים כיום ל-*${formatCurrency(result, targetCurrency)}*.`);
            return;
        }

        // ── 2. Greeting / Help ────────────────────────────────────────────────
        if (['הי', 'היי', 'שלום', 'הלו', 'היוש', 'start', 'help', 'עזרה'].some(v => textLower.startsWith(v))) {
            await reply(
                `👋 *היי ברוכים הבאים!*\n` +
                `אני ה-*Budget Queen* 👑 ואני כאן לעזור לכם לנהל את התקציב ישירות מהוואטסאפ!\n\n` +
                `*איך זה עובד?* 💸\n\n` +
                `1️⃣ *הגדרת תקציב:*\n` +
                `💡 כתבו: \`תקציב 200$\` או \`תקציב 3000\`.\n\n` +
                `2️⃣ *תיעוד הוצאה:*\n` +
                `💡 נסו: \`50 מונית\` או \`12 קפה\`.\n` +
                `💡 החזר כספי? \`-100 ביט מחבר\`.\n\n` +
                `3️⃣ *בדיקת מצב:* כתבו \`סיכום\`.\n\n` +
                `4️⃣ *מחשבון מט"ח חי:*\n` +
                `💡 \`כמה זה 100 דולר בשקלים?\` 🧮\n\n` +
                `5️⃣ *טעות?* כתבו \`מחיקה\`. חודש חדש? \`איפוס\`.`
            );
            return;
        }

        // ── 3. Reset ──────────────────────────────────────────────────────────
        if (['איפוס', 'reset'].includes(textLower)) {
            const { error: delErr } = await dbQuery(() =>
                supabase.from('expenses').delete().eq('phone_number', fromNumber)
            );
            if (delErr) {
                await reply(`⚠️ שגיאת מסד נתונים באיפוס ההוצאות:\n${delErr.message}`);
                return;
            }
            const { error: updErr } = await dbQuery(() =>
                supabase.from('user_budgets').update({ budget: 0, remaining: 0 }).eq('phone_number', fromNumber)
            );
            if (updErr) {
                await reply(`⚠️ שגיאת מסד נתונים באיפוס התקציב:\n${updErr.message}`);
                return;
            }
            await reply("🔄 אופסנו הכול! איזה כיף להתחיל נקי ✨\nכתבו 'תקציב' בשילוב סכום כדי להתחיל.");
            return;
        }

        // ── 4. Delete Last Expense ────────────────────────────────────────────
        if (['מחיקה', 'ביטול', 'delete', 'undo'].includes(textLower)) {
            const { data: lastExpenses, error: fetchErr } = await dbQuery(() =>
                supabase
                    .from('expenses')
                    .select('*')
                    .eq('phone_number', fromNumber)
                    .order('created_at', { ascending: false })
                    .limit(1)
            );

            if (fetchErr) {
                await reply(`⚠️ שגיאת מסד נתונים בשליפת ההוצאה האחרונה:\n${fetchErr.message}`);
                return;
            }

            if (!lastExpenses || lastExpenses.length === 0) {
                await reply('📭 לא מצאתי אף הוצאה קודמת למחוק!');
                return;
            }

            const lastExp = lastExpenses[0];

            const { error: delErr } = await dbQuery(() =>
                supabase.from('expenses').delete().eq('id', lastExp.id)
            );
            if (delErr) {
                await reply(`⚠️ שגיאת מסד נתונים במחיקת ההוצאה:\n${delErr.message}`);
                return;
            }

            // 1-to-1: restore original amount in display_currency
            const updatedRemaining = user.remaining + lastExp.amount_original;
            const { error: updErr } = await dbQuery(() =>
                supabase.from('user_budgets').update({ remaining: updatedRemaining }).eq('phone_number', fromNumber)
            );
            if (updErr) {
                await reply(`⚠️ שגיאת מסד נתונים בעדכון היתרה:\n${updErr.message}`);
                return;
            }

            await reply(
                `🗑️ *בוטל בהצלחה:* "${lastExp.description}" על סך ${formatCurrency(lastExp.amount_original, user.display_currency)} נמחק.\n` +
                `💰 יתרה מעודכנת: ${formatCurrency(updatedRemaining, user.display_currency)}`
            );
            return;
        }

        // ── 5. Set Budget ─────────────────────────────────────────────────────
        if (textLower.startsWith('תקציב')) {
            const numberMatch = textRaw.match(/(-?\d[\d,.]*)/);
            if (!numberMatch) {
                await reply("לא הבנתי את הסכום 😅 נסו: 'תקציב 3000' או 'תקציב 500$'");
                return;
            }

            const amount = parseFloat(numberMatch[1].replace(/,/g, ''));
            const currency = detectCurrency(textRaw, user.display_currency);

            // Clear old expenses on new budget
            const { error: delErr } = await dbQuery(() =>
                supabase.from('expenses').delete().eq('phone_number', fromNumber)
            );
            if (delErr) {
                await reply(`⚠️ שגיאת מסד נתונים בניקוי ההוצאות הישנות:\n${delErr.message}`);
                return;
            }

            const { error: updErr } = await dbQuery(() =>
                supabase
                    .from('user_budgets')
                    .update({ budget: amount, remaining: amount, display_currency: currency })
                    .eq('phone_number', fromNumber)
            );
            if (updErr) {
                await reply(`⚠️ שגיאת מסד נתונים בהגדרת התקציב:\n${updErr.message}`);
                return;
            }

            await reply(`💰 הוגדר תקציב חדש: ${formatCurrency(amount, currency)}.\nנשאר לכם: ${formatCurrency(amount, currency)}`);
            return;
        }

        // ── 6. Summary ────────────────────────────────────────────────────────
        if (['סיכום', 'הוצאות', 'סטטוס'].includes(textLower)) {
            const { data: expenses, error: fetchErr } = await dbQuery(() =>
                supabase
                    .from('expenses')
                    .select('*')
                    .eq('phone_number', fromNumber)
                    .order('created_at', { ascending: true })
            );

            if (fetchErr) {
                await reply(`⚠️ שגיאת מסד נתונים בשליפת הוצאות:\n${fetchErr.message}`);
                return;
            }

            const cur = user.display_currency;

            if (!expenses || expenses.length === 0) {
                await reply(
                    `📊 *סטטוס תקציב:*\n\n` +
                    `עדיין לא נרשמו הוצאות החודש. נקי ונוצץ! ✨\n\n` +
                    `💰 תקציב: ${formatCurrency(user.budget, cur)}\n` +
                    `💵 יתרה: ${formatCurrency(user.remaining, cur)}`
                );
                return;
            }

            const listLines = expenses.map((exp, i) => {
                const emoji = exp.category ? exp.category.split(' ')[0] : '📝';
                return `${i + 1}. ${emoji} *${formatCurrency(exp.amount_original, cur)}* – ${exp.description}`;
            });

            const totalSpent = user.budget - user.remaining;
            const progressBar = generateProgressBar(user.remaining, user.budget);

            let summaryText =
                `📊 *סיכום התקציב שלכם:*\n` +
                `---------------------------\n` +
                `${listLines.join('\n')}\n` +
                `---------------------------\n\n` +
                `${progressBar}\n\n` +
                `📉 סה"כ בוזבז: ${formatCurrency(totalSpent, cur)}\n` +
                `💵 נשאר בארנק: ${formatCurrency(user.remaining, cur)}\n` +
                `💰 תקציב מקורי: ${formatCurrency(user.budget, cur)}`;

            if (user.remaining < 0) {
                summaryText += `\n\n⚠️ *שימו לב:* חרגתם מהתקציב ב- ${formatCurrency(Math.abs(user.remaining), cur)}! 😱`;
            }

            await reply(summaryText);
            return;
        }

        // ── 7. Add Expense / Credit ───────────────────────────────────────────
        if (/-?\d/.test(textRaw)) {
            if (!user.budget || user.budget === 0) {
                await reply("📝 קודם מגדירות תקציב, סיס! נסו: 'תקציב 3000' או 'תקציב 500$'");
                return;
            }

            const numberMatch = textRaw.match(/(-?\d[\d,.]*)/);
            if (!numberMatch) return;

            const amountOriginal = parseFloat(numberMatch[1].replace(/,/g, ''));
            let description = textRaw
                .replace(numberMatch[0], '')
                .replace(/(דולר|דולרים|יורו|אירו|יורואים|אירואים|שקל|שקלים|ש"ח|שח|₪|\$|€)/gi, '')
                .trim();
            if (!description) description = amountOriginal < 0 ? 'זיכוי/החזר' : 'הוצאה כללית';

            const category = autoCategory(description);

            // 1-to-1: store in user's display_currency with no conversion
            const { error: insErr } = await dbQuery(() =>
                supabase.from('expenses').insert([{
                    phone_number: fromNumber,
                    amount_ils: amountOriginal,          // kept for schema compat
                    amount_original: amountOriginal,
                    currency_original: user.display_currency,
                    description,
                    category,
                }])
            );
            if (insErr) {
                await reply(`⚠️ שגיאת מסד נתונים ברישום ההוצאה:\n${insErr.message}`);
                return;
            }

            // 1-to-1 balance update
            const newRemaining = user.remaining - amountOriginal;
            const { error: updErr } = await dbQuery(() =>
                supabase.from('user_budgets').update({ remaining: newRemaining }).eq('phone_number', fromNumber)
            );
            if (updErr) {
                await reply(`⚠️ שגיאת מסד נתונים בעדכון היתרה:\n${updErr.message}`);
                return;
            }

            const cur = user.display_currency;

            if (amountOriginal < 0) {
                await reply(
                    `💰 *איזה כיף, החזר!*\nנוסף זיכוי של ${formatCurrency(Math.abs(amountOriginal), cur)} עבור "${description}".\n` +
                    `💵 יתרה מעודכנת: ${formatCurrency(newRemaining, cur)}`
                );
            } else {
                let msg =
                    `➕ *נרשמה הוצאה:* ${formatCurrency(amountOriginal, cur)} [${category.split(' ')[0]}]\n` +
                    `✍️ עבור: "${description}"\n` +
                    `💵 נשאר בתקציב: ${formatCurrency(newRemaining, cur)}`;
                if (newRemaining < 0) msg += ` ⚠️ (אתם במינוס!)`;
                await reply(msg);
            }
            return;
        }

        // ── Default / Unknown ─────────────────────────────────────────────────
        await reply("לא בטוחה שהבנתי 🫣\nכתבו 'היי' כדי לקבל את רשימת הפקודות המלאה!");

    } catch (err) {
        // Top-level safety net — should rarely fire given per-operation error handling above
        console.error('Unhandled webhook error:', err.message, err.stack);
    }
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Budget Queen server running on port ${PORT}`));
