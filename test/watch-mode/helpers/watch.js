import fs from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';

import ava from '@ava/test';
import {temporaryDirectoryTask} from 'tempy';

import {available} from '../../../lib/watcher.js';
import {cwd, exec} from '../../helpers/exec.js';

export const test = available(fileURLToPath(import.meta.url)) ? ava : ava.skip;
export const serial = available(fileURLToPath(import.meta.url)) ? ava.serial : ava.serial.skip;

export const withFixture = fixture => async (t, task) => {
	let completedTask = false;
	await temporaryDirectoryTask(async dir => {
		await fs.cp(cwd(fixture), dir, {recursive: true});

		async function * run(args = [], options = {}) {
			yield * exec(['--watch', ...args], {...options, cwd: dir, env: {AVA_FORCE_CI: 'not-ci', ...options.env}});
		}

		async function mkdir(file, options = {}) {
			await fs.mkdir(path.join(dir, file), options);
		}

		async function read(file) {
			return fs.readFile(path.join(dir, file), 'utf8');
		}

		async function rm(file, options = {}) {
			await fs.rm(path.join(dir, file), options);
		}

		async function stat(file) {
			return fs.stat(path.join(dir, file));
		}

		async function touch(file) {
			const time = new Date();
			await fs.utimes(path.join(dir, file), time, time);
		}

		async function write(file, contents = '') {
			await fs.writeFile(path.join(dir, file), contents);
		}

		const operations = {
			mkdir,
			read,
			rm,
			stat,
			touch,
			write,
		};

		let activeWatchCount = 0;
		await task(t, {
			...operations,
			dir,
			run,
			async watch(handlers, args = [], options = {}) {
				activeWatchCount++;

				let signalDone;
				const donePromise = new Promise(resolve => {
					signalDone = resolve;
				});
				let isDone = false;
				const done = () => {
					activeWatchCount--;
					isDone = true;
					signalDone({done: true});
				};

				let idlePromise = new Promise(() => {});
				let assertingIdle = false;
				let failedIdleAssertion = false;
				const assertIdle = async next => {
					assertingIdle = true;

					// TODO: When testing using AVA 6, enable for better managed timeouts.
					// t.timeout(10_000);

					const promise = Promise.all([delay(5000, null, {ref: false}), next?.()]).finally(() => {
						if (idlePromise === promise) {
							idlePromise = new Promise(() => {});
							assertingIdle = false;
							// TODO: When testing using AVA 6, enable for better managed timeouts.
							// t.timeout(0);
							if (failedIdleAssertion) {
								failedIdleAssertion = false;
								t.fail('Watcher performed a test run while it should have been idle');
							}
						}

						return {};
					});
					idlePromise = promise;

					await promise;
				};

				let state = {};
				let pendingState;

				const results = run(args, options);
				try {
					let nextResult = results.next();
					while (true) { // eslint-disable-line no-constant-condition
						const item = await Promise.race([nextResult, idlePromise, donePromise]); // eslint-disable-line no-await-in-loop

						if (item.value) {
							failedIdleAssertion ||= assertingIdle;

							state = (await pendingState) ?? state; // eslint-disable-line no-await-in-loop
							const result = item.value;
							const {[result.runCount]: handler = handlers.else} = handlers;
							pendingState = handler?.call({assertIdle, done, ...operations}, result, state);

							if (!item.done && !isDone) {
								nextResult = results.next();
							}
						}

						if (item.done || isDone) {
							item.value?.process.send('abort-watcher');
							break;
						}
					}
				} finally {
					results.return();

					// Handle outstanding promises in case they reject.
					if (assertingIdle) {
						await idlePromise;
					}

					await pendingState;
				}
			},
		});

		t.is(activeWatchCount, 0, 'Handlers for all watch() calls should have invoked `this.done()` to end their tests');
		completedTask = true;
	}).catch(error => {
		if (!completedTask) {
			throw error;
		}

		switch (error.code) { // https://github.com/sindresorhus/tempy/issues/47
			case 'EBUSY':
			case 'EMFILE':
			case 'ENFILE':
			case 'ENOTEMPTY':
			case 'EPERM ': {
				return;
			}

			default: {
				throw error;
			}
		}
	});
};
