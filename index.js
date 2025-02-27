const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const winston = require('winston');
const express = require('express');
const dotenv = require('dotenv');

// Load environment variables
dotenv.config();

// Initialize express app
const app = express();
const port = process.env.PORT || 3000;

// Configure logging
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' })
  ]
});

// Bot configuration
const BOT_TOKEN = '7754167221:AAEvaVemP_SNyiZ-wKiWwMi4VuodF9kpaXk';
const API_HOST = 'mobile-pre.at.dz';

// Initialize bot with enhanced configuration
const bot = new TelegramBot(BOT_TOKEN, {
  polling: true,
  request: {
    timeout: 60000,
    retry: 3,
    retryDelay: 1000
  }
});

// Express middleware
app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

// State management with enhanced error handling
const userStates = new Map();
const userDataStore = new Map();

// State constants
const STATES = {
  LOGIN: {
    WAITING_FOR_ND: 'LOGIN_WAITING_FOR_ND',
    WAITING_FOR_PASSWORD: 'LOGIN_WAITING_FOR_PASSWORD'
  },
  PSTN: {
    WAITING_FOR_ND: 'PSTN_WAITING_FOR_ND'
  },
  LTE: {
    WAITING_FOR_ND: 'LTE_WAITING_FOR_ND',
    WAITING_FOR_AMOUNT: 'LTE_WAITING_FOR_AMOUNT'
  },
  ADSL: {
    WAITING_FOR_ND: 'ADSL_WAITING_FOR_ND',
    WAITING_FOR_AMOUNT: 'ADSL_WAITING_FOR_AMOUNT'
  },
  VOUCHER: {
    WAITING_FOR_ND: 'VOUCHER_WAITING_FOR_ND',
    WAITING_FOR_CODE: 'VOUCHER_WAITING_FOR_CODE'
  },
  VOUCHER_SCAN: {
    WAITING_FOR_CODE: 'VOUCHER_SCAN_WAITING_FOR_CODE'
  }
};

// Helper functions with improved error handling
const setState = (chatId, state) => {
  try {
    userStates.set(chatId, state);
  } catch (error) {
    logger.error('Error setting state:', error);
  }
};

const getState = (chatId) => {
  try {
    return userStates.get(chatId);
  } catch (error) {
    logger.error('Error getting state:', error);
    return null;
  }
};

const clearState = (chatId) => {
  try {
    userStates.delete(chatId);
    userDataStore.delete(chatId);
  } catch (error) {
    logger.error('Error clearing state:', error);
  }
};

const setUserData = (chatId, data) => {
  try {
    const currentData = userDataStore.get(chatId) || {};
    userDataStore.set(chatId, { ...currentData, ...data });
  } catch (error) {
    logger.error('Error setting user data:', error);
  }
};

const getUserData = (chatId) => {
  try {
    return userDataStore.get(chatId) || {};
  } catch (error) {
    logger.error('Error getting user data:', error);
    return {};
  }
};

// Enhanced API Helper functions with retries
async function makeApiRequest(url, headers, payload, method = 'post', retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await axios({
        method,
        url: `https://${API_HOST}${url}`,
        headers,
        data: method !== 'get' ? payload : undefined,
        params: method === 'get' ? payload : undefined,
        timeout: 30000
      });
      return response.data;
    } catch (error) {
      logger.error('API request failed:', {
        url,
        method,
        attempt,
        error: error.message
      });
      
      if (attempt === retries) throw error;
      await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
    }
  }
}

async function processPayment(chatId, invoiceNumber, serviceType, paymentUrl, checkUrl, checkPayloadService = null, amount = null) {
  try {
    const headers = {
      'Content-Type': 'application/json',
      'accept-encoding': 'gzip',
      'host': API_HOST,
      'user-agent': 'Dart/2.18 (dart:io)'
    };

    const checkPayload = checkPayloadService 
      ? { nd: invoiceNumber, service: checkPayloadService }
      : { nd: invoiceNumber };

    const checkJson = await makeApiRequest(checkUrl, headers, checkPayload);

    if (checkJson.code === '0' && checkJson.INFO) {
      const ncli = checkJson.INFO.ncli || '';
      const serviceTypeValue = serviceType === 'ADSL' ? checkJson.INFO.type1 || 'FTTH' : serviceType;

      const payPayload = {
        nd: invoiceNumber,
        ncli,
        type: serviceTypeValue,
        montant: amount ? amount.toString() : '595.0',
        ip: '0.0.0.0',
        mode: 'Edahabia',
        lang: 'fr',
        type_client: serviceType === 'ADSL' ? 'Residential' : null
      };

      const payJson = await makeApiRequest(paymentUrl, headers, payPayload);

      if (payJson.code === '0' && payJson.message) {
        await bot.sendMessage(chatId, `✅ ${serviceType} Payment link: ${payJson.message}`);
      } else {
        await bot.sendMessage(chatId, `❌ ${serviceType} Payment failed: ${JSON.stringify(payJson)}`);
      }
    } else {
      await bot.sendMessage(
        chatId,
        `❌ ${serviceType} Invoice not found or check error: ${checkJson.message || JSON.stringify(checkJson)}`
      );
    }
  } catch (error) {
    logger.error(`${serviceType} payment error:`, error);
    await bot.sendMessage(chatId, `❌ ${serviceType}: Something went wrong during payment processing: ${error.message}`);
  }

  clearState(chatId);
}

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  clearState(chatId);
  
  const welcomeText = 
    '👋 Welcome to the Payment Bot!\n\n' +
    '📱 Available commands:\n\n' +
    '🔐 /login  → Login to your account\n' +
    '📞 /fact → Pay your PSTN (Landline)\n' +
    '📡 /4g   → Pay your 4G LTE\n' +
    '🌐 /adsl → Pay your ADSL or FTTH\n' +
    '📋 /unpaid → Check unpaid invoices\n' +
    '🎟️ /voucher → Apply ADSL/FTTH voucher\n' +
    '📸 /scanvoucher → Scan voucher\n' +
    '❌ /cancel → Stop current operation\n\n' +
    '✨ Simply pick the appropriate command to start.';

  await bot.sendMessage(chatId, welcomeText);
});

// Login flow
bot.onText(/\/login/, async (msg) => {
  const chatId = msg.chat.id;
  setState(chatId, STATES.LOGIN.WAITING_FOR_ND);
  await bot.sendMessage(chatId, '📱 Please enter your phone number (nd):');
});

// PSTN flow
bot.onText(/\/fact/, async (msg) => {
  const chatId = msg.chat.id;
  setState(chatId, STATES.PSTN.WAITING_FOR_ND);
  await bot.sendMessage(chatId, '📞 Please enter your PSTN invoice number (nd):');
});

// 4G LTE flow
bot.onText(/\/4g/, async (msg) => {
  const chatId = msg.chat.id;
  setState(chatId, STATES.LTE.WAITING_FOR_ND);
  await bot.sendMessage(chatId, '📡 Enter your 4G LTE number (nd):');
});

// ADSL/FTTH flow
bot.onText(/\/adsl/, async (msg) => {
  const chatId = msg.chat.id;
  setState(chatId, STATES.ADSL.WAITING_FOR_ND);
  await bot.sendMessage(chatId, '🌐 Enter your ADSL/FTTH number (nd):');
});

// Voucher flow
bot.onText(/\/voucher/, async (msg) => {
  const chatId = msg.chat.id;
  setState(chatId, STATES.VOUCHER.WAITING_FOR_ND);
  await bot.sendMessage(chatId, '🎟️ Please enter the ADSL/FTTH number (nd):');
});

// Scan voucher flow
bot.onText(/\/scanvoucher/, async (msg) => {
  const chatId = msg.chat.id;
  setState(chatId, STATES.VOUCHER_SCAN.WAITING_FOR_CODE);
  await bot.sendMessage(chatId, '📸 Please send the voucher image or enter the voucher code:');
});

// Cancel command
bot.onText(/\/cancel/, async (msg) => {
  const chatId = msg.chat.id;
  const currentState = getState(chatId);
  
  if (!currentState) {
    await bot.sendMessage(chatId, '❌ There\'s nothing to cancel.');
    return;
  }

  clearState(chatId);
  await bot.sendMessage(chatId, '✅ Operation cancelled successfully.');
});

// Handle photo messages for voucher scanning
bot.on('photo', async (msg) => {
  const chatId = msg.chat.id;
  const currentState = getState(chatId);

  if (currentState !== STATES.VOUCHER_SCAN.WAITING_FOR_CODE) {
    await bot.sendMessage(chatId, '⚠️ Please use /scanvoucher command first to scan a voucher.');
    return;
  }

  try {
    const fileId = msg.photo[msg.photo.length - 1].file_id;
    
    await bot.sendMessage(chatId, '🔍 Processing voucher image...');

    const file = await bot.getFile(fileId);
    const imageResponse = await axios({
      method: 'get',
      url: `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`,
      responseType: 'arraybuffer'
    });

    const imageBase64 = Buffer.from(imageResponse.data).toString('base64');
    
    const headers = {
      'Content-Type': 'application/json',
      'accept-encoding': 'gzip',
      'host': API_HOST,
      'user-agent': 'Dart/2.18 (dart:io)'
    };

    const scanResponse = await makeApiRequest('/api/epay/voucherScan', headers, { 
      image: imageBase64,
      format: 'base64'
    });

    if (scanResponse && scanResponse.code === '0' && scanResponse.voucher) {
      const voucherCode = scanResponse.voucher;
      const voucherType = scanResponse.type;

      logger.info('Successfully scanned voucher:', { code: voucherCode, type: voucherType });

      if (voucherType.toUpperCase().includes('ADSL') || voucherType.toUpperCase().includes('FTTH')) {
        await bot.sendMessage(chatId, `✅ Found ADSL/FTTH voucher!\n\n🎟️ Code: ${voucherCode}\n\n📱 Please enter your service number (nd):`);
        setUserData(chatId, { voucherCode, voucherType: 'ADSL' });
      } else {
        await bot.sendMessage(chatId, `✅ Found 4G LTE voucher!\n\n🎟️ Code: ${voucherCode}\n\n📱 Please enter your service number (nd):`);
        setUserData(chatId, { voucherCode, voucherType: '4G' });
      }
      setState(chatId, 'APPLY_VOUCHER_WAITING_FOR_ND');
    } else {
      logger.error('Failed to scan voucher:', scanResponse);
      await bot.sendMessage(chatId, '❌ Could not read voucher from image.\n\n🔄 Please try again or enter the code manually.');
      clearState(chatId);
    }
  } catch (error) {
    logger.error('Error processing voucher image:', error);
    await bot.sendMessage(chatId, '❌ Failed to process the voucher image.\n\n🔄 Please try again or enter the code manually.');
    clearState(chatId);
  }
});

// Message handler for all states
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const currentState = getState(chatId);
  
  if (msg.text && msg.text.startsWith('/')) return;
  if (msg.photo) return;
  
  if (!currentState) return;

  if (!msg.text) {
    await bot.sendMessage(chatId, '⚠️ Please send text messages only.');
    return;
  }

  const text = msg.text.trim();

  try {
    switch (currentState) {
      case STATES.LOGIN.WAITING_FOR_ND:
        setUserData(chatId, { loginNd: text });
        setState(chatId, STATES.LOGIN.WAITING_FOR_PASSWORD);
        await bot.sendMessage(chatId, '🔑 Please enter your password:');
        break;

      case STATES.LOGIN.WAITING_FOR_PASSWORD:
        const userData = getUserData(chatId);
        const loginData = {
          nd: userData.loginNd,
          password: text
        };

        try {
          const headers = {
            'Content-Type': 'application/json',
            'accept-encoding': 'gzip',
            'host': API_HOST,
            'user-agent': 'Dart/2.18 (dart:io)'
          };

          const loginJson = await makeApiRequest('/api/auth/login', headers, loginData);
          
          if (loginJson?.meta_data?.original?.token) {
            const token = loginJson.meta_data.original.token;
            setUserData(chatId, { authToken: token });
            
            const accountHeaders = {
              ...headers,
              'Authorization': `Bearer ${token}`
            };
            
            const accountJson = await makeApiRequest('/api/compte', accountHeaders, {}, 'get');
            
            if (accountJson) {
              const formattedAccount = [
                '✅ Login successful!\n',
                '👤 Account Information:',
                `📱 Number: ${accountJson.nd || 'N/A'}`,
                `📍 Address: ${accountJson.adresse || 'N/A'}`,
                `👤 Name: ${accountJson.nom || 'N/A'}`,
                `👤 First name: ${accountJson.prenom || 'N/A'}`,
                `📧 Email: ${accountJson.email || 'N/A'}`,
                `🆔 Ncli: ${accountJson.ncli || 'N/A'}`,
                `📊 Number of invoices: ${accountJson.nb || '0'}`
              ].join('\n');

              await bot.sendMessage(chatId, formattedAccount);
            }
            
            clearState(chatId);
          } else {
            await bot.sendMessage(chatId, '❌ Login failed. Please check your credentials and try again.');
          }
        } catch (error) {
          logger.error('Login error:', error);
          await bot.sendMessage(chatId, `❌ Login failed: ${error.message}`);
          clearState(chatId);
        }
        break;

      case STATES.PSTN.WAITING_FOR_ND:
        if (!text.match(/^\d+$/)) {
          await bot.sendMessage(chatId, '⚠️ Invalid PSTN invoice number! Please enter digits only.');
          return;
        }
        await processPayment(
          chatId,
          text,
          'PSTN',
          '/api/epay/paiementFact',
          '/api/epay/checkNdFact',
          'Dus'
        );
        break;

      case STATES.LTE.WAITING_FOR_ND:
        if (!text.match(/^\d+$/)) {
          await bot.sendMessage(chatId, '⚠️ Invalid 4G LTE number! Please enter digits only.');
          return;
        }
        setUserData(chatId, { lteNd: text });
        setState(chatId, STATES.LTE.WAITING_FOR_AMOUNT);
        await bot.sendMessage(chatId, '💰 Please enter the payment amount:');
        break;

      case STATES.LTE.WAITING_FOR_AMOUNT:
        const lteAmount = parseFloat(text.replace(',', '.'));
        if (isNaN(lteAmount) || lteAmount <= 0) {
          await bot.sendMessage(chatId, '⚠️ Invalid amount! Please enter a positive number (e.g., 1000.50).');
          return;
        }
        const lteData = getUserData(chatId);
        await processPayment(
          chatId,
          lteData.lteNd,
          '4G LTE',
          '/api/epay/paiementLte',
          '/api/epay/checkNdLte',
          null,
          lteAmount
        );
        break;

      case STATES.ADSL.WAITING_FOR_ND:
        if (!text.match(/^\d+$/)) {
          await bot.sendMessage(chatId, '⚠️ Invalid ADSL/FTTH number! Please enter digits only.');
          return;
        }
        setUserData(chatId, { adslNd: text });
        setState(chatId, STATES.ADSL.WAITING_FOR_AMOUNT);
        await bot.sendMessage(chatId, '💰 Please enter the payment amount:');
        break;

      case STATES.ADSL.WAITING_FOR_AMOUNT:
        const adslAmount = parseFloat(text.replace(',', '.'));
        if (isNaN(adslAmount) || adslAmount <= 0) {
          await bot.sendMessage(chatId, '⚠️ Invalid amount! Please enter a positive number (e.g., 1000.50).');
          return;
        }
        const adslData = getUserData(chatId);
        await processPayment(
          chatId,
          adslData.adslNd,
          'ADSL',
          '/api/epay/paiementAdsl',
          '/api/epay/checkNdAdsl',
          'Paiement',
          adslAmount
        );
        break;

      case STATES.VOUCHER.WAITING_FOR_ND:
        if (!text.match(/^\d+$/)) {
          await bot.sendMessage(chatId, '⚠️ Invalid ADSL/FTTH number! Please enter digits only.');
          return;
        }
        setUserData(chatId, { voucherNd: text });
        setState(chatId, STATES.VOUCHER.WAITING_FOR_CODE);
        await bot.sendMessage(chatId, '🎟️ Please enter the voucher code:');
        break;

      case STATES.VOUCHER.WAITING_FOR_CODE:
        const voucherData = getUserData(chatId);
        try {
          const headers = {
            'Content-Type': 'application/json',
            'accept-encoding': 'gzip',
            'host': API_HOST,
            'user-agent': 'Dart/2.18 (dart:io)'
          };

          const checkJson = await makeApiRequest(
            '/api/epay/checkNdAdsl',
            headers,
            { nd: voucherData.voucherNd, service: 'Paiement' }
          );

          if (checkJson.code === '0' && checkJson.INFO) {
            const ncli = checkJson.INFO.ncli || '';
            const voucherPayload = {
              nd: voucherData.voucherNd,
              ncli,
              type: 'FTTH',
              voucher: text,
              ip: '0.0.0.0'
            };

            const voucherJson = await makeApiRequest('/api/epay/voucherAdsl', headers, voucherPayload);
            
            if (voucherJson.code === '0') {
              await bot.sendMessage(chatId, '✅ ADSL/FTTH Voucher recharge successful!');
            } else if (voucherJson.code === '118100548') {
              await bot.sendMessage(chatId, '❌ ADSL/FTTH Voucher recharge failed. Please try again.');
            } else {
              await bot.sendMessage(chatId, `❌ ADSL/FTTH Voucher application result: ${voucherJson.message || JSON.stringify(voucherJson)}`);
            }
          } else {
            await bot.sendMessage(
              chatId,
              `❌ ADSL/FTTH Number not found or check error: ${JSON.stringify(checkJson)}`
            );
          }
        } catch (error) {
          logger.error('Error applying voucher:', error);
          await bot.sendMessage(chatId, `❌ Something went wrong while applying voucher: ${error.message}`);
        }
        clearState(chatId);
        break;

      case STATES.VOUCHER_SCAN.WAITING_FOR_CODE:
        try {
          const headers = {
            'Content-Type': 'application/json',
            'accept-encoding': 'gzip',
            'host': API_HOST,
            'user-agent': 'Dart/2.18 (dart:io)'
          };

          const scanJson = await makeApiRequest('/api/epay/voucherScan', headers, { voucher: text });
          
          if (scanJson && scanJson.code === '0') {
            await bot.sendMessage(chatId, '📱 Please enter your service number (nd) to apply the voucher:');
            setUserData(chatId, { 
              voucherCode: text,
              voucherType: scanJson.type
            });
            setState(chatId, 'APPLY_VOUCHER_WAITING_FOR_ND');
          } else {
            await bot.sendMessage(chatId, '❌ Invalid voucher code. Please try again.');
            clearState(chatId);
          }
        } catch (error) {
          logger.error('Voucher scan failed:', error);
          await bot.sendMessage(chatId, `❌ Voucher scan failed: ${error.message}`);
          clearState(chatId);
        }
        break;

      case 'APPLY_VOUCHER_WAITING_FOR_ND':
        try {
          const userData = getUserData(chatId);
          const { voucherCode, voucherType } = userData;

          if (!text.match(/^\d+$/)) {
            await bot.sendMessage(chatId, '⚠️ Invalid service number! Please enter digits only.');
            return;
          }

          const headers = {
            'Content-Type': 'application/json',
            'accept-encoding': 'gzip',
            'host': API_HOST,
            'user-agent': 'Dart/2.18 (dart:io)'
          };

          const isAdsl = voucherType.toUpperCase().includes('ADSL') || voucherType.toUpperCase().includes('FTTH');
          
          if (isAdsl) {
            const checkJson = await makeApiRequest(
              '/api/epay/checkNdAdsl',
              headers,
              { nd: text, service: 'Paiement' }
            );

            if (checkJson.code === '0' && checkJson.INFO) {
              const ncli = checkJson.INFO.ncli || '';
              const voucherPayload = {
                nd: text,
                ncli,
                type: 'FTTH',
                voucher: voucherCode,
                ip: '0.0.0.0'
              };

              const voucherJson = await makeApiRequest('/api/epay/voucherAdsl', headers, voucherPayload);
              
              if (voucherJson.code === '0') {
                await bot.sendMessage(chatId, '✅ ADSL/FTTH Voucher recharge successful!');
              } else if (voucherJson.code === '118100548') {
                await bot.sendMessage(chatId, '❌ ADSL/FTTH Voucher recharge failed. Please try again.');
              } else {
                await bot.sendMessage(chatId, `❌ ADSL/FTTH Voucher application result: ${voucherJson.message || JSON.stringify(voucherJson)}`);
              }
            } else {
              await bot.sendMessage(chatId, `❌ ADSL/FTTH Number check failed: ${checkJson.message || JSON.stringify(checkJson)}`);
            }
          } else {
            const checkJson = await makeApiRequest(
              '/api/epay/checkNdLte',
              headers,
              { nd: text }
            );

            if (checkJson.code === '0' && checkJson.INFO) {
              const voucherPayload = {
                nd: text,
                voucher: voucherCode,
                ip: '0.0.0.0'
              };

              const voucherJson = await makeApiRequest('/api/epay/voucherLte', headers, voucherPayload);
              
              if (voucherJson.code === '0') {
                await bot.sendMessage(chatId, '✅ 4G LTE Voucher recharge successful!');
              } else if (voucherJson.code === '118100548') {
                await bot.sendMessage(chatId, '❌ 4G LTE Voucher recharge failed. Please try again.');
              } else {
                await bot.sendMessage(chatId, `❌ 4G LTE Voucher application result: ${voucherJson.message || JSON.stringify(voucherJson)}`);
              }
            } else {
              await bot.sendMessage(chatId, `❌ 4G LTE Number check failed: ${checkJson.message || JSON.stringify(checkJson)}`);
            }
          }
        } catch (error) {
          logger.error('Error applying voucher:', error);
          await bot.sendMessage(chatId, `❌ Failed to apply voucher: ${error.message}`);
        }
        clearState(chatId);
        break;
    }
  } catch (error) {
    logger.error('Error in message handler:', error);
    await bot.sendMessage(chatId, `❌ An error occurred: ${error.message}\n\n🔄 Please try again.`);
    clearState(chatId);
  }
});

// Error handling
bot.on('polling_error', (error) => {
  logger.error('Polling error:', error);
});

// Handle process termination
process.on('SIGINT', () => {
  bot.stopPolling();
  process.exit(0);
});

process.on('SIGTERM', () => {
  bot.stopPolling();
  process.exit(0);
});

// Start Express server
app.listen(port, () => {
  logger.info(`Express server listening on port ${port}`);
});

logger.info('Bot started successfully!');
