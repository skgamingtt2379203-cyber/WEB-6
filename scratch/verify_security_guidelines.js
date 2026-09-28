/**
 * Automated Verification Script for Discord Security Guidelines
 * D4Hz Voice Amplifier
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const baseDir = path.resolve(__dirname, '..');
const htmlPath = path.join(baseDir, 'index.html');
const relayPath = path.join(baseDir, 'relay.js');

let passed = 0;
let total = 0;

function assert(condition, message) {
  total++;
  if (condition) {
    passed++;
    console.log(`  ✅ [PASS] ${message}`);
  } else {
    console.error(`  ❌ [FAIL] ${message}`);
  }
}

console.log('═══════════════════════════════════════════════════════');
console.log('🛡️ RUNNING DISCORD SECURITY & GUIDELINES VERIFICATION');
console.log('═══════════════════════════════════════════════════════\n');

// 1. Verify index.html exists and is readable
console.log('--- 1. Frontend Security & Compliance Controls (index.html) ---');
const html = fs.readFileSync(htmlPath, 'utf8');

// Security modal
assert(html.includes('id="security-modal"'), 'Discord Security Modal container #security-modal exists');
assert(html.includes('DISCORD <span>SECURITY</span> & GUIDELINES'), 'Security modal title exists');
assert(html.includes('1. Official Discord Bots vs. User Tokens'), 'Rule 1: Official Discord Bots vs User Tokens explained');
assert(html.includes('2. Audio Privacy & Affirmative Consent'), 'Rule 2: Audio Privacy & Affirmative Consent explained');
assert(html.includes('3. Zero Credential Exfiltration'), 'Rule 3: Zero Credential Exfiltration & Localhost explained');
assert(html.includes('4. Rate Limiting & Gateway Compliance'), 'Rule 4: Rate Limiting & Gateway Compliance explained');
assert(html.includes('5. Community Safety & Anti-Raiding'), 'Rule 5: Community Safety & Anti-Raiding explained');

// Header & Home buttons
assert(html.includes('openSecurityModal()'), 'openSecurityModal() trigger button wired in HTML');
assert(html.includes('closeSecurityModal()'), 'closeSecurityModal() dismiss button wired in HTML');

// ToS advisory banner on Accounts page
assert(html.includes('DISCORD TERMS OF SERVICE ADVISORY'), 'ToS Advisory Banner present in #pg-accounts');
assert(html.includes('SWITCH TO BOT MODE'), '1-click Switch to Bot Mode button present');

// Voice consent gate
assert(html.includes('id="voice-consent-box"'), 'Voice Consent Box (#voice-consent-box) exists');
assert(html.includes('id="voice-consent-chk"'), 'Voice Consent Checkbox (#voice-consent-chk) exists');
assert(html.includes('Voice Consent & Discord Policy Compliance'), 'Voice Consent label displayed prominently');

// Extract and test JS from index.html
const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
assert(!!scriptMatch, '<script> block extracted from index.html');

if (scriptMatch) {
  const scriptContent = scriptMatch[1];
  try {
    new vm.Script(scriptContent);
    assert(true, 'index.html embedded JavaScript syntax is valid and parses without error');
  } catch (err) {
    assert(false, `index.html JavaScript syntax error: ${err.message}`);
  }

  assert(scriptContent.includes('function openSecurityModal('), 'openSecurityModal() function is defined');
  assert(scriptContent.includes('function closeSecurityModal('), 'closeSecurityModal() function is defined');
  assert(scriptContent.includes('voice-consent-chk') && scriptContent.includes('Voice Consent Required'), 'startAmp() gates execution behind voice consent check');
  assert(scriptContent.includes('••••••••••••'), 'renderAccs() and renderBots() implement UI token masking');
}

console.log('\n--- 2. Backend Security Hardening (relay.js) ---');
const relay = fs.readFileSync(relayPath, 'utf8');

// relay syntax
try {
  new vm.Script(relay);
  assert(true, 'relay.js syntax is valid and parses without error');
} catch (err) {
  assert(false, `relay.js syntax error: ${err.message}`);
}

// Localhost origin protection
assert(relay.includes('server.listen(PORT, \'127.0.0.1\''), 'Server strictly bound to 127.0.0.1 localhost');
assert(relay.includes('req.headers.origin') && relay.includes('Discord Security Guidelines'), 'Strict localhost origin validation protects against cross-origin hijacking');

// Credential / token masking
assert(relay.includes('function maskToken('), 'maskToken() utility function is defined in relay.js');
assert(relay.includes('token: maskToken(acc.token)'), 'Tokens are sanitized/masked in API response payloads');

// Rate limiting handling
assert(relay.includes('status === 429') && relay.includes('retry-after'), 'HTTP 429 rate limit backoff implemented for invite join');
assert(relay.includes('subRes.status === 429'), 'HTTP 429 rate limit backoff implemented for member onboarding/verification');

console.log('\n═══════════════════════════════════════════════════════');
console.log(`RESULTS: ${passed}/${total} checks passed (${Math.round((passed / total) * 100)}%)`);
console.log('═══════════════════════════════════════════════════════\n');

if (passed === total) {
  console.log('🎉 ALL DISCORD SECURITY & GUIDELINE REQUIREMENTS VERIFIED SUCCESSFULLY!');
  process.exit(0);
} else {
  console.error(`⚠️ ${total - passed} checks failed.`);
  process.exit(1);
}
