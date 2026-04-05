// test-dual-interface.js
// Chạy: node test-dual-interface.js

const BASE_URL = 'http://localhost:3000';  // Đổi thành domain thật nếu cần
const ADMIN_BASE_URL = 'http://localhost:3000';

// Màu sắc cho console
const colors = {
   reset: '\x1b[0m',
   green: '\x1b[32m',
   red: '\x1b[31m',
   yellow: '\x1b[33m',
   blue: '\x1b[34m',
   cyan: '\x1b[36m',
   gray: '\x1b[90m'
};

function log(color, ...args) {
   console.log(color, ...args, colors.reset);
}

async function testCase(name, url, options = {}, expectedBehavior) {
   log(colors.cyan, `\n📋 Test: ${name}`);
   log(colors.gray, `   URL: ${url}`);

   try {
      const res = await fetch(url, options);
      const html = await res.text();

      // Kiểm tra kết quả
      const hasAffiliateLink = html.includes('/go/') || html.includes('registerLink');
      const isBlog = html.includes('FX Review Daily') || html.includes('blog.html');
      const isLanding = html.includes('assets/index') || html.includes('_vite') || html.includes('root');

      let result = '';
      let passed = false;

      if (expectedBehavior === 'redirect' && (res.status === 302 || res.status === 301)) {
         result = `✅ PASS (Redirect ${res.status})`;
         passed = true;
      } else if (expectedBehavior === 'blog' && (isBlog || (!hasAffiliateLink && !isLanding))) {
         result = `✅ PASS (Blog HTML - không có affiliate link)`;
         passed = true;
      } else if (expectedBehavior === 'landing' && (isLanding || hasAffiliateLink)) {
         result = `✅ PASS (Landing Page - có affiliate link)`;
         passed = true;
      } else if (expectedBehavior === '403' && res.status === 403) {
         result = `✅ PASS (403 Forbidden)`;
         passed = true;
      } else if (expectedBehavior === 'blocked' && (res.status === 403 || res.status === 444 || res.status === 302)) {
         result = `✅ PASS (Blocked - status ${res.status})`;
         passed = true;
      } else {
         result = `❌ FAIL (Expected: ${expectedBehavior}, Got: status ${res.status}, blog: ${isBlog}, landing: ${isLanding})`;
         passed = false;
      }

      log(passed ? colors.green : colors.red, `   ${result}`);
      return passed;
   } catch (err) {
      log(colors.red, `   ❌ ERROR: ${err.message}`);
      return false;
   }
}

async function loginAndGetToken() {
   log(colors.cyan, '\n🔐 Logging in to get admin token...');

   try {
      const res = await fetch(`${ADMIN_BASE_URL}/api/admin/login`, {
         method: 'POST',
         headers: { 'Content-Type': 'application/json' },
         body: JSON.stringify({ username: 'admin', password: 'change-me' })
      });

      const data = await res.json();
      if (data.success) {
         log(colors.green, `   ✅ Token obtained`);
         return data.token;
      } else {
         log(colors.red, `   ❌ Login failed: ${data.error}`);
         return null;
      }
   } catch (err) {
      log(colors.red, `   ❌ Login error: ${err.message}`);
      return null;
   }
}

async function updateBlockLists(token) {
   log(colors.cyan, '\n📝 Updating block lists for testing...');

   const config = {
      blockedCountries: ["RU", "CY", "BY", "IR", "KP", "AU", "IL", "BZ", "SC", "VU", "KY", "UA", "NG", "BD"],
      blockedIPs: ["185.220.101.45", "185.220.101.34"],
      blockedCIDR: ["3.0.0.0/8", "52.0.0.0/8", "185.220.100.0/22"],
      blockedASNs: ["AS16509", "AS15169", "AS8075"],
      badReferrers: ["xm.com", "icmarkets.com", "pepperstone.com"],
      blockAction: "redirect",
      blockRedirectUrl: "https://google.com",
      suspiciousAction: "blog",
      suspiciousRedirectUrl: ""
   };

   try {
      const res = await fetch(`${ADMIN_BASE_URL}/api/admin/domains/localhost`, {
         method: 'PUT',
         headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
         },
         body: JSON.stringify(config)
      });

      if (res.ok) {
         log(colors.green, `   ✅ Block lists updated`);
         return true;
      } else {
         log(colors.red, `   ❌ Failed to update block lists`);
         return false;
      }
   } catch (err) {
      log(colors.red, `   ❌ Error: ${err.message}`);
      return false;
   }
}

async function testBasicCases() {
   log(colors.yellow, '\n' + '='.repeat(60));
   log(colors.yellow, '🔰 TEST CASE 1: Basic Cases (IP thường)');
   log(colors.yellow, '='.repeat(60));

   let allPassed = true;

   // Case 1.1: Normal IP → Landing page
   const test1 = await testCase(
      'Normal IP (clean)',
      `${BASE_URL}/`,
      {},
      'landing'
   );
   allPassed = allPassed && test1;

   // Case 1.2: /verify route
   const test2 = await testCase(
      'BotCheckPage (/verify)',
      `${BASE_URL}/verify`,
      {},
      'landing'  // BotCheckPage hiển thị bình thường
   );
   allPassed = allPassed && test2;

   // Case 1.3: Subpath
   const test3 = await testCase(
      'Subpath (/abc)',
      `${BASE_URL}/abc`,
      {},
      'landing'
   );
   allPassed = allPassed && test3;

   // Case 1.4: API không bị block
   const test4 = await testCase(
      'API /api/links (không bị block)',
      `${BASE_URL}/api/links`,
      {},
      'landing'  // API trả về JSON
   );
   allPassed = allPassed && test4;

   return allPassed;
}

async function testHardBlockCases() {
   log(colors.yellow, '\n' + '='.repeat(60));
   log(colors.yellow, '🔴 TEST CASE 2: Hard Block (handled)');
   log(colors.yellow, '='.repeat(60));

   let allPassed = true;

   // Case 2.1: Static blocked IP
   const test1 = await testCase(
      'Static blocked IP (185.220.101.45)',
      `${BASE_URL}/`,
      { headers: { 'X-Forwarded-For': '185.220.101.45' } },
      'blocked'
   );
   allPassed = allPassed && test1;

   // Case 2.2: CIDR range (AWS)
   const test2 = await testCase(
      'CIDR range - AWS IP (3.0.0.1)',
      `${BASE_URL}/`,
      { headers: { 'X-Forwarded-For': '3.0.0.1' } },
      'blocked'
   );
   allPassed = allPassed && test2;

   // Case 2.3: Tor exit node
   const test3 = await testCase(
      'Tor exit node (185.220.100.1)',
      `${BASE_URL}/`,
      { headers: { 'X-Forwarded-For': '185.220.100.1' } },
      'blocked'
   );
   allPassed = allPassed && test3;

   return allPassed;
}

async function testSuspiciousCases() {
   log(colors.yellow, '\n' + '='.repeat(60));
   log(colors.yellow, '🟡 TEST CASE 3: Suspicious → blog.html');
   log(colors.yellow, '='.repeat(60));

   let allPassed = true;

   // Case 3.1: Blocked country (Cyprus)
   const test1 = await testCase(
      'Blocked country - Cyprus IP (31.153.0.1)',
      `${BASE_URL}/`,
      { headers: { 'X-Forwarded-For': '31.153.0.1' } },
      'blog'
   );
   allPassed = allPassed && test1;

   // Case 3.2: Blocked country (Australia)
   const test2 = await testCase(
      'Blocked country - Australia IP (1.1.1.1)',
      `${BASE_URL}/`,
      { headers: { 'X-Forwarded-For': '1.1.1.1', 'X-CountryCode': 'AU' } },
      'blog'
   );
   allPassed = allPassed && test2;

   // Case 3.3: Bad referrer (xm.com)
   const test3 = await testCase(
      'Bad referrer - xm.com',
      `${BASE_URL}/`,
      { headers: { 'Referer': 'https://xm.com/forex' } },
      'blog'
   );
   allPassed = allPassed && test3;

   // Case 3.4: Bad referrer (icmarkets.com)
   const test4 = await testCase(
      'Bad referrer - icmarkets.com',
      `${BASE_URL}/`,
      { headers: { 'Referer': 'https://icmarkets.com/trading' } },
      'blog'
   );
   allPassed = allPassed && test4;

   // Case 3.5: Proxy detected (giả lập)
   const test5 = await testCase(
      'Proxy detected (simulated)',
      `${BASE_URL}/`,
      { headers: { 'X-Forwarded-For': '45.33.0.1' } }, // Linode IP
      'blog'
   );
   allPassed = allPassed && test5;

   return allPassed;
}

async function testRepeatVisitCase() {
   log(colors.yellow, '\n' + '='.repeat(60));
   log(colors.yellow, '🔄 TEST CASE 4: Repeat Visit (>5 lần)');
   log(colors.yellow, '='.repeat(60));

   const testIP = '192.168.1.100';
   let allPassed = true;

   log(colors.cyan, `\n📋 Test: Repeat visit from IP ${testIP}`);

   // Lần 1-5: vẫn là landing page
   for (let i = 1; i <= 5; i++) {
      const res = await fetch(`${BASE_URL}/`, {
         headers: { 'X-Forwarded-For': testIP }
      });
      const html = await res.text();
      const hasAffiliate = html.includes('/go/') || html.includes('Open Account');

      log(colors.gray, `   Lần ${i}: ${hasAffiliate ? 'Landing page' : 'Blog page'}`);

      if (i <= 5 && !hasAffiliate) {
         log(colors.red, `   ❌ FAIL: Lần ${i} đã thấy blog.html sớm`);
         allPassed = false;
         break;
      }
   }

   // Lần thứ 6: phải là blog.html
   const res = await fetch(`${BASE_URL}/`, {
      headers: { 'X-Forwarded-For': testIP }
   });
   const html = await res.text();
   const isBlog = html.includes('FX Review Daily') || (!html.includes('/go/') && !html.includes('Open Account'));

   if (isBlog) {
      log(colors.green, `   ✅ PASS: Lần thứ 6 -> blog.html`);
   } else {
      log(colors.red, `   ❌ FAIL: Lần thứ 6 vẫn là landing page`);
      allPassed = false;
   }

   return allPassed;
}

async function testBlockActionCases() {
   log(colors.yellow, '\n' + '='.repeat(60));
   log(colors.yellow, '🎯 TEST CASE 5: Block Actions');
   log(colors.yellow, '='.repeat(60));

   let allPassed = true;

   // Case 5.1: Redirect action
   const test1 = await testCase(
      'Redirect action (blocked IP → redirect)',
      `${BASE_URL}/`,
      { headers: { 'X-Forwarded-For': '185.220.101.45' } },
      'redirect'
   );
   allPassed = allPassed && test1;

   return allPassed;
}

async function testApiEndpoints() {
   log(colors.yellow, '\n' + '='.repeat(60));
   log(colors.yellow, '🔌 TEST CASE 6: API Endpoints (không bị block)');
   log(colors.yellow, '='.repeat(60));

   let allPassed = true;

   // Case 6.1: /api/links từ IP bị block
   const test1 = await testCase(
      '/api/links từ IP bị block (vẫn hoạt động)',
      `${BASE_URL}/api/links`,
      { headers: { 'X-Forwarded-For': '185.220.101.45' } },
      'landing'  // API trả về JSON
   );
   allPassed = allPassed && test1;

   // Case 6.2: /api/sub-paths
   const test2 = await testCase(
      '/api/sub-paths',
      `${BASE_URL}/api/sub-paths`,
      {},
      'landing'
   );
   allPassed = allPassed && test2;

   // Case 6.3: /go/register
   const test3 = await testCase(
      '/go/register (redirect)',
      `${BASE_URL}/go/register`,
      { redirect: 'manual' },
      'redirect'
   );
   allPassed = allPassed && test3;

   return allPassed;
}

async function testDifferentDomains() {
   log(colors.yellow, '\n' + '='.repeat(60));
   log(colors.yellow, '🌐 TEST CASE 7: Different Domains');
   log(colors.yellow, '='.repeat(60));

   let allPassed = true;

   // Case 7.1: localhost
   const test1 = await testCase(
      'Domain: localhost',
      `${BASE_URL}/`,
      {},
      'landing'
   );
   allPassed = allPassed && test1;

   return allPassed;
}

async function runAllTests() {
   log(colors.cyan, '\n' + '='.repeat(60));
   log(colors.cyan, '🧪 STARTING DUAL INTERFACE TESTS');
   log(colors.cyan, '='.repeat(60));

   const results = [];

   // Login để update config (nếu cần)
   const token = await loginAndGetToken();
   if (token) {
      await updateBlockLists(token);
   } else {
      log(colors.yellow, '\n⚠️ Skipping block lists update (login failed)');
   }

   // Chạy các test cases
   results.push({ name: 'Basic Cases', passed: await testBasicCases() });
   results.push({ name: 'Hard Block Cases', passed: await testHardBlockCases() });
   results.push({ name: 'Suspicious Cases', passed: await testSuspiciousCases() });
   results.push({ name: 'Repeat Visit', passed: await testRepeatVisitCase() });
   results.push({ name: 'Block Actions', passed: await testBlockActionCases() });
   results.push({ name: 'API Endpoints', passed: await testApiEndpoints() });
   results.push({ name: 'Different Domains', passed: await testDifferentDomains() });

   // Tổng kết
   log(colors.yellow, '\n' + '='.repeat(60));
   log(colors.yellow, '📊 TEST SUMMARY');
   log(colors.yellow, '='.repeat(60));

   let totalPassed = 0;
   for (const result of results) {
      if (result.passed) {
         log(colors.green, `   ✅ ${result.name}: PASSED`);
         totalPassed++;
      } else {
         log(colors.red, `   ❌ ${result.name}: FAILED`);
      }
   }

   log(colors.cyan, `\n📈 Total: ${totalPassed}/${results.length} test suites passed`);

   if (totalPassed === results.length) {
      log(colors.green, '\n🎉 ALL TESTS PASSED! Dual Interface is working correctly!');
   } else {
      log(colors.red, '\n⚠️ SOME TESTS FAILED. Please check the logs above.');
   }
}

// Chạy tests
runAllTests().catch(console.error);