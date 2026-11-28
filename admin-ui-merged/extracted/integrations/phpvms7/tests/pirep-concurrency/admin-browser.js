const assert = require('node:assert/strict');
const { chromium } = require(process.env.VUSCG_PLAYWRIGHT || 'playwright');

const origin = process.env.PIREP_FIXTURE_ORIGIN;
const row = (page, id = 'report1') => page.locator('#row_' + id);
const review = (page, id) => row(page, id).locator('[data-vuscg-pirep-review]');
const revision = (page, id) => review(page, id).locator('[name="review_revision"]');
const badge = (page, id) => row(page, id).locator('[id$="_status_container"] span');
const warning = (page, id) => review(page, id).getByRole('status');
const action = (page, name, id) => review(page, id).getByRole('button', { name, exact: true });

function decision(request, id = 'report1') {
  return new URL(request.url()).pathname === '/admin/pireps/' + id + '/status' && request.method() === 'POST';
}

async function clickReview(page, label, expected, id = 'report1') {
  const posted = page.waitForRequest(request => decision(request, id));
  const response = page.waitForResponse(result => decision(result.request(), id));
  await action(page, label, id).click();
  assert.deepEqual((await posted).postDataJSON(), {
    pirep_id: id,
    new_status: label === 'Accept' ? '2' : '6',
    review_revision: expected.revision,
    on_edit_page: expected.detail ?? false,
    _token: 'fixture-csrf',
  });
  assert.equal((await response).status(), 200);
}

async function assertBadge(page, name, id = 'report1') {
  await badge(page, id).filter({ hasText: new RegExp('^' + name + '$') }).waitFor();
}

async function run() {
  assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  const browser = await chromium.launch({
    executablePath: process.env.VUSCG_CHROMIUM || '/usr/bin/chromium',
    args: ['--no-sandbox'],
  });
  try {
    const list = await browser.newPage();
    const stale = await browser.newPage();
    const reloads = [];
    let listPosts = 0;
    list.on('request', request => { if (decision(request)) listPosts++; });

    await list.goto(origin + '/admin/pireps');
    await stale.goto(origin + '/admin/pireps');
    assert.equal(await revision(list).inputValue(), 'legacy');
    assert.equal(await revision(list, 'report2').inputValue(), 'legacy');
    assert.equal(await action(list, 'Edit').count(), 1);
    assert.equal(await action(list, 'View').count(), 1);
    assert.equal(await action(list, 'Delete').count(), 1);

    // Hold the first response in the browser while the native test route commits.
    let release;
    const delayed = new Promise(resolve => { release = resolve; });
    await list.route('**/report1/status', async route => {
      const response = await route.fetch();
      await delayed;
      await route.fulfill({ response });
    });
    try {
      const posted = list.waitForRequest(request => decision(request));
      await action(list, 'Accept').click();
      assert.deepEqual((await posted).postDataJSON(), {
        pirep_id: 'report1', new_status: '2', review_revision: 'legacy', on_edit_page: false, _token: 'fixture-csrf',
      });
      assert.equal(await action(list, 'Reject').isDisabled(), true);
      await list.locator('#report1_reject').evaluate(form => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
      assert.equal(listPosts, 1);
    } finally {
      release();
    }
    await assertBadge(list, 'Accepted');
    await list.unroute('**/report1/status');
    assert.equal(await badge(list, 'report2').textContent(), 'Pending');
    assert.match(await revision(list).inputValue(), /^[a-f0-9]{32}$/);

    await clickReview(stale, 'Reject', { revision: 'legacy' });
    await warning(stale).waitFor();
    assert.match(await warning(stale).textContent(), /Current state is Accepted/);
    await assertBadge(stale, 'Accepted');
    assert.equal(await action(stale, 'Accept').count(), 0);
    const currentListRevision = await revision(stale).inputValue();
    assert.match(currentListRevision, /^[a-f0-9]{32}$/);
    await clickReview(stale, 'Reject', { revision: currentListRevision });
    await assertBadge(stale, 'Rejected');
    assert.equal(await warning(stale).count(), 0);
    assert.equal(await action(stale, 'View').count(), 1);
    assert.equal(await action(stale, 'Delete').count(), 1);
    console.log('PASS list review, row isolation, duplicate suppression, stale conflict and deliberate reversal');

    assert.equal((await list.request.post(origin + '/fixture/reset')).status(), 200);
    await list.reload();
    const detail = await browser.newPage();
    await detail.goto(origin + '/admin/pireps/report1/edit');
    detail.on('framenavigated', frame => { if (frame === detail.mainFrame()) reloads.push(frame.url()); });
    assert.equal(await action(detail, 'Edit').count(), 0);
    assert.equal(await action(detail, 'View').count(), 1);
    assert.equal(await action(detail, 'Delete').count(), 1);

    await clickReview(list, 'Accept', { revision: 'legacy' });
    await assertBadge(list, 'Accepted');
    await clickReview(detail, 'Reject', { revision: 'legacy', detail: true });
    await warning(detail).waitFor();
    assert.match(await warning(detail).textContent(), /Current state is Accepted/);
    await assertBadge(detail, 'Accepted');
    assert.equal(reloads.length, 0);
    assert.equal(await action(detail, 'Edit').count(), 0);
    assert.equal(await action(detail, 'Reject').locator('..').getAttribute('class'), 'pirep_change_status');

    const currentDetailRevision = await revision(detail).inputValue();
    const reloaded = detail.waitForEvent('framenavigated', { predicate: frame => frame === detail.mainFrame() });
    await clickReview(detail, 'Reject', { revision: currentDetailRevision, detail: true });
    await reloaded;
    await assertBadge(detail, 'Rejected');
    assert.equal(reloads.length, 1);
    assert.equal(await warning(detail).count(), 0);
    assert.equal(await action(detail, 'Edit').count(), 0);
    console.log('PASS detail inline conflict, current state and revision, detail controls and successful reload');

    const invalidRequests = [
      { new_status: '2', _token: 'fixture-csrf' },
      { new_status: '2', review_revision: '', _token: 'fixture-csrf' },
      { new_status: '2', review_revision: 'LEGACY', _token: 'fixture-csrf' },
      { new_status: 'bogus', review_revision: 'legacy', _token: 'fixture-csrf' },
    ];
    for (const data of invalidRequests) {
      assert.equal((await list.request.post(origin + '/admin/pireps/report2/status', { data })).status(), 422);
    }
    assert.equal((await list.request.post(origin + '/admin/pireps/report2/status', {
      data: { new_status: '2', review_revision: 'legacy' },
    })).status(), 419);
    await list.reload();
    await assertBadge(list, 'Pending', 'report2');
    console.log('PASS controller rejects missing or invalid revisions, invalid direction and missing fixture CSRF');

    list.on('dialog', dialog => dialog.accept());
    await revision(list, 'report2').evaluate(input => { input.value = ''; });
    const missing = list.waitForEvent('dialog');
    await action(list, 'Accept', 'report2').click();
    assert.match((await missing).message(), /review information is missing/);
    await list.reload();

    await list.route('**/report2/status', route => route.fulfill({ body: '<body>Sign in</body>', contentType: 'text/html' }));
    const malformed = list.waitForEvent('dialog');
    await action(list, 'Accept', 'report2').click();
    assert.match((await malformed).message(), /decision could not be confirmed/);
    assert.equal(await action(list, 'Reject', 'report2').isDisabled(), true);
    assert.equal(await revision(list, 'report2').inputValue(), 'legacy');
    assert.equal(await badge(list, 'report2').textContent(), 'Pending');
    console.log('PASS missing token and malformed AJAX response fail closed');
  } finally {
    await browser.close();
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
