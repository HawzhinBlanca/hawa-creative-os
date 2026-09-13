import * as fs from 'node:fs';
import * as path from 'node:path';

async function dispatchToTelegram() {
  const botToken = '8975998512:AAELwUMofl2S-Rho0zrXjVL66tlJzTAfHzI';
  const chatId = '7191500129';
  const filePath = path.resolve('exports/kaae_presidential_invitation_master.png');

  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const fileBuffer = fs.readFileSync(filePath);
  const blob = new Blob([fileBuffer], { type: 'image/png' });

  const caption = 
`👑 *KAAE Presidential VIP Invitation — Official Design*

🎯 *Title:* THE NATIONAL STANDARDS FOR QUALITY ASSURANCE IN EDUCATION
🏛️ *Host:* Kurdistan Accrediting Association for Education (KAAE)
🌟 *Guest of Honor:* His Excellency Prime Minister Masrour Barzani
🤝 *Official Launch:* MoU Signing by Minister of Education & Minister of Higher Education and Scientific Research

📅 *Date & Time:* September 9, 2026 | 2:30 PM
📍 *Venue:* Saad Abdullah Conference Hall, Erbil
🎟️ *Access:* By Invitation Only (Personal & Non-Transferable)

_Full verbatim content preserved adhering to KAAE royal navy and gold brand guidelines._`;

  const replyMarkup = JSON.stringify({
    inline_keyboard: [
      [
        { text: '✅ Approve & Publish', callback_data: 'act:approve_kaae_presidential_master' },
        { text: '✏️ Request Revision', callback_data: 'act:revise_kaae_presidential_master' }
      ],
      [
        { text: '🎨 Open in Hawa Desk Studio', url: 'https://restaurant-threatened-replaced-reason.trycloudflare.com/review?taskId=551aea6e-702e-4c80-ad99-d8b1720fabc4&mode=review' }
      ]
    ]
  });

  const formData = new FormData();
  formData.append('chat_id', chatId);
  formData.append('caption', caption);
  formData.append('parse_mode', 'Markdown');
  formData.append('photo', blob, 'kaae_presidential_invitation_master.png');
  formData.append('reply_markup', replyMarkup);

  console.log('Dispatching photo to Telegram chat:', chatId);
  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
    method: 'POST',
    body: formData,
  });

  const result = await response.json();
  console.log('Telegram API Response:', JSON.stringify(result, null, 2));
}

dispatchToTelegram().catch((err) => {
  console.error('Failed to dispatch to Telegram:', err);
  process.exit(1);
});
