'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');
const puppeteer = require('puppeteer');
const pLimit = require('p-limit');

// Puppeteer is not fully supported due to https://github.com/puppeteer/puppeteer/issues/3667 (doesn't intercept targets such as window.open)
// Playwright is not supported due to https://github.com/microsoft/playwright/issues/7220 (cache disabled if intercepting)

const limit = pLimit(1);
const container = fs.readFileSync('container.js', 'utf8');

const containerReferences = new Map();

const newPage = async (context) => {
	const APIFY_CONTAINER = 'apify.container.';
	const key = APIFY_CONTAINER + Math.random().toString(36).slice(2) + '.';
	const defineKey = `const key = '${key}';\n`;

	const page = await context.newPage();
	await page.setRequestInterception(true);

	await page.evaluateOnNewDocument('(() => {' + defineKey + container + '})();');

	// TODO: Maybe instead of setting the cookies on page, we should set them on the default one (about:blank)? This way we can prevent cancel errors etc.
	//       If we used playwright, we would do context.setCookie(...cookies);

	const requestHandler = async (request) => {
		if (request.isInterceptResolutionHandled()) return;

		const headers = request.headers();
		const cookies = await page.cookies();

		await page.deleteCookie(...cookies);

		for (const cookie of cookies) {
			if (!cookie.name.startsWith(APIFY_CONTAINER)) {
				cookie.name = key + cookie.name;
			}
		}

		const containeredCookies = cookies.filter(cookie => cookie.name.startsWith(key)).map(cookie => ({...cookie, name: cookie.name.slice(key.length)}));

		try {
			await page.setCookie(...containeredCookies);
			await request.continue();
		} finally {
			try {
				await page.deleteCookie(...containeredCookies);
				await page.setCookie(...cookies);
			} catch (error) {
				console.error('Failed to restore container: ' + key);
			}
		}
	};

	page.on('request', async (request) => {
		try {
			// This needs to be limited because we can't intercept responses yet.
			// See https://github.com/puppeteer/puppeteer/issues/1191
			await limit(requestHandler, request);
		} catch {
			// Most likely the page was closed.
		}
	});

	if (containerReferences.has(key)) {
		containerReferences.set(key, containerReferences.get(key) + 1);
	} else {
		containerReferences.set(key, 1);
	}

	page.on('close', () => {
		const value = containerReferences.get(key) - 1;

		if (value === 0) {
			containerReferences.delete(key);

			console.log('TODO: clean up container data', key);
			// TODO: clean up container data
			//       Ideally, we'd fetch all cookies and storage and remove entries starting with container key.
			//       But that is not possible with puppeteer (possible with playwright).
			//
			//       We could mantain a list of destroyed containers and remove the cookies in requestHandler,
			//       but we can't remove the key from the list because we don't know what websites do have those cookies,
			//       so this would lead to a memory leak.
			//
			//       Also it isn't possible to clean up storages with puppeteer (but possible with playwright).
		} else {
			containerReferences.set(key, value);
		}
	});

	return page;
};

(async () => {
	const browser = await puppeteer.launch({
		headless: false,
	});

	const open = async () => {
		const page = await newPage(browser);
		await page.goto('https://www.google.com');

		return page;
	};

	const pages = await Promise.all([ open(), open() ]);
})();

