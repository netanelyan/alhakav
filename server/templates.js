import { ALERT, MSG, PAY, SCENE, SETUP, SVC } from './copy.js';

// The templates in the look of every message (copy.js), as Meta's API takes them (POST <META_WABA_ID>/message_templates),
// made by the same functions that write the plain text, so a template and its text never part. Each takes over from
// the one before it by itself once Meta approves it (meta.js pickTemplate). docs/whatsapp-templates.md has them, and
// `node server/main.js templates [file]` writes them on the server, where SENDER_LINE is.

const AVI = 'אבי אינסטלציה';

/** Every template to submit, with a sample for each variable. Throws without SENDER_LINE or SITE_URL. */
export function templateDefs(env) {
  const sender = String(env.SENDER_LINE || '').trim();
  const site = String(env.SITE_URL || '').trim().replace(/\/+$/, '');
  if (!sender || !site) throw new Error('templates: SENDER_LINE and SITE_URL are needed');
  const body = (text, sample) => ({ type: 'BODY', text, example: { body_text: [sample] } });
  const page = { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'לראות את הדף שלכם', url: `${site}/p/{{1}}`, example: [`${site}/p/abcdefgh23`] }, { type: 'QUICK_REPLY', text: 'לא, תודה' }] };
  const admin = { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'לפתוח את הפרטים', url: `${site}/admin/{{1}}`, example: [`${site}/admin/leads/12`] }] };
  const t = (name, category, components) => ({ name, language: 'he', category, components });
  return [
    t('alhakav_page_trade', 'MARKETING', [body(MSG.firstTrade('{{2}}', '', sender, false, '{{1}}'), [SCENE.plumber, `אצל ${AVI}`]), page]),
    t('alhakav_page_reminder_v2', 'MARKETING', [body(MSG.reminder('{{1}}', '', sender, false), [`אצל ${AVI}`]), page]),
    t('alhakav_caller_v2', 'UTILITY', [body(SVC.callerFirst('{{1}}'), [AVI])]),
    t('alhakav_summary_v2', 'UTILITY', [
      body(SVC.summary({ time: '{{1}}', what: '{{2}}', place: '{{3}}', urgency: '{{4}}', phone: '{{5}}' }), ['10:41', 'נזילה חזקה מתחת לכיור', 'הרצל 15, אשדוד, קומה 3', 'דחוף, המים זורמים', '054-123-4567']),
    ]),
    t('alhakav_call_alert_v2', 'UTILITY', [body(SVC.note({ time: '{{1}}', number: '{{2}}', line: '{{3}}' }), ['10:41', '050-000-0000', SVC.lines.noReply])]),
    t('alhakav_payment_v2', 'UTILITY', [
      body(PAY.message({ line: '{{1}}', amount: '{{2}}', details: '{{3}}' }), [
        PAY.lines.soon({ business: AVI, paidUntil: '24.11.2026', from: '25.11.2026', until: '24.12.2026' }),
        '175.82',
        'בנק הפועלים (12), סניף 345, חשבון 678901, על שם ישראל ישראלי',
      ]),
    ]),
    t('alhakav_owner_alert_v2', 'UTILITY', [body(ALERT.template, [`${AVI} (050-000-0000) ענו להודעה שלנו`, 'הם כתבו: כמה זה עולה?']), admin]),
    t('alhakav_setup', 'UTILITY', [
      body(SETUP.text({ business: '{{1}}', codes: ['```{{2}}```', '```{{3}}```', '```{{4}}```'], assist: '{{5}}' }), [AVI, '**61*043763889**20#', '**67*043763889#', '**62*043763889#', '055-273-5207']),
    ]),
  ];
}
