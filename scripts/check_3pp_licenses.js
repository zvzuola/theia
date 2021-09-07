/********************************************************************************
 * Copyright (c) 2021 Ericsson and others
 *
 * This program and the accompanying materials are made available under the
 * terms of the Eclipse Public License v. 2.0 which is available at
 * http://www.eclipse.org/legal/epl-2.0.
 *
 * This Source Code may also be made available under the following Secondary
 * Licenses when the conditions for such availability set forth in the Eclipse
 * Public License v. 2.0 are satisfied: GNU General Public License, version 2
 * with the GNU Classpath Exception which is available at
 * https://www.gnu.org/software/classpath/license.html.
 *
 * SPDX-License-Identifier: EPL-2.0 OR GPL-2.0 WITH Classpath-exception-2.0
 ********************************************************************************/
// @ts-check

const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const NO_COLOR = Boolean(process.env['NO_COLOR']);
const dashLicensesJar = path.resolve(__dirname, 'download/dash-licenses.jar');
const dashLicensesSummary = path.resolve(__dirname, '../license-check-summary.txt');
const dashLicensesBaseline = path.resolve(__dirname, '../license-check-baseline.json');
const dashLicensesUrl = 'https://repo.eclipse.org/service/local/artifact/maven/redirect?r=dash-licenses&g=org.eclipse.dash&a=org.eclipse.dash.licenses&v=LATEST';

main().catch(error => {
    console.error(error);
    process.exit(1);
});

async function main() {
    if (!fs.existsSync(dashLicensesJar)) {
        info('Fetching dash-licenses...');
        fs.mkdirSync(path.dirname(dashLicensesJar), { recursive: true });
        const curlError = getErrorFromStatus(spawn(
            'curl', ['-L', dashLicensesUrl, '-o', dashLicensesJar],
        ));
        if (curlError) {
            error(curlError);
            process.exit(1);
        }
    }
    if (fs.existsSync(dashLicensesSummary)) {
        info('Backing up previous summary...');
        fs.renameSync(dashLicensesSummary, `${dashLicensesSummary}.old`);
    }
    info('Running dash-licenses...');
    const dashError = getErrorFromStatus(spawn(
        'java', ['-jar', dashLicensesJar, 'yarn.lock', '-batch', '50', '-timeout', '240', '-summary', dashLicensesSummary],
        { stdio: ['ignore', 'ignore', 'inherit'] },
    ));
    if (dashError) {
        warn(dashError);
    }
    const restricted = await getRestrictedDependenciesFromSummary(dashLicensesSummary);
    if (restricted.length > 0) {
        if (fs.existsSync(dashLicensesBaseline)) {
            info('Checking results against the baseline...');
            const baseline = readBaseline(dashLicensesBaseline);
            const unmatched = new Set(baseline.keys());
            const unhandled = restricted.filter(entry => {
                unmatched.delete(entry.dependency);
                return !baseline.has(entry.dependency);
            });
            if (unmatched.size > 0) {
                warn('Some entries in the baseline did not match anything from dash-licenses output:');
                for (const dependency of unmatched) {
                    console.log(magenta(`> ${dependency}`));
                    const data = baseline.get(dependency);
                    if (data) {
                        console.warn(`${dependency}:`, data);
                    }
                }
            }
            if (unhandled.length > 0) {
                error(`Found results that aren't part of the baseline!`);
                logRestrictedDashSummaryEntries(unhandled);
                process.exit(1);
            }
        } else {
            error(`Found unhandled restricted dependencies!`);
            logRestrictedDashSummaryEntries(restricted);
            process.exit(1);
        }
    }
    info('Done.');
    process.exit(0);
}

/**
 * @param {Iterable<DashSummaryEntry>} entries
 * @return {void}
 */
function logRestrictedDashSummaryEntries(entries) {
    for (const { dependency: entry, license } of entries) {
        console.log(red(`X ${entry}, ${license}`));
    }
}

/**
 * @param {string} summary path to the summary file.
 * @returns {Promise<DashSummaryEntry[]>} list of restricted dependencies.
 */
async function getRestrictedDependenciesFromSummary(summary) {
    const restricted = [];
    for await (const entry of readSummaryLines(summary)) {
        if (entry.status.toLocaleLowerCase() === 'restricted') {
            restricted.push(entry);
        }
    }
    return restricted.sort(
        (a, b) => a.dependency.localeCompare(b.dependency)
    );
}

/**
 * Read each entry from dash's summary file and collect each entry.
 * This is essentially a cheap CSV parser.
 * @param {string} summary path to the summary file.
 * @returns {AsyncIterableIterator<DashSummaryEntry>} reading completed.
 */
async function* readSummaryLines(summary) {
    for await (const line of readline.createInterface(fs.createReadStream(summary))) {
        const [dependency, license, status, source] = line.split(', ');
        yield { dependency, license, status, source };
    }
}

/**
 * Handle both list and object format for the baseline json file.
 * @param {string} baseline path to the baseline json file.
 * @returns {Map<string, any>} map of dependencies to ignore if restricted, value is an optional data field.
 */
function readBaseline(baseline) {
    const json = JSON.parse(fs.readFileSync(baseline, 'utf8'));
    if (Array.isArray(json)) {
        return new Map(json.map(element => [element, null]));
    } else if (typeof json === 'object' && json !== null) {
        return new Map(Object.entries(json));
    }
    console.error(`ERROR: Invalid format for "${baseline}"`);
    process.exit(1);
}

/**
 * Spawn a process. Exits with code 1 on spawn error (e.g. file not found).
 * @param {string} bin
 * @param {string[]} args
 * @param {import('child_process').SpawnSyncOptions} [opts]
 * @returns {import('child_process').SpawnSyncReturns}
 */
function spawn(bin, args, opts = {}) {
    opts = { stdio: 'inherit', ...opts };
    /** @type {any} */
    const status = cp.spawnSync(bin, args, opts);
    // Add useful fields to the returned status object:
    status.bin = bin;
    status.args = args;
    status.opts = opts;
    // Abort on spawn error:
    if (status.error) {
        console.error(status.error);
        process.exit(1);
    }
    return status;
}

/**
 * @param {import('child_process').SpawnSyncReturns} status
 * @returns {string | undefined} Error message if the process errored, `undefined` otherwise.
 */
function getErrorFromStatus(status) {
    if (typeof status.signal === 'string') {
        return `Command ${prettyCommand(status)} exited with signal: ${status.signal}`;
    } else if (status.status !== 0) {
        return `Command ${prettyCommand(status)} exited with code: ${status.status}`;
    }
}

/**
 * @param {any} status
 * @param {number} [indent]
 * @returns {string} Pretty command with both bin and args as stringified JSON.
 */
function prettyCommand(status, indent = 2) {
    return JSON.stringify([status.bin, ...status.args], undefined, indent);
}

function info(text) { console.warn(cyan(`INFO: ${text}`)); }
function warn(text) { console.warn(yellow(`WARN: ${text}`)); }
function error(text) { console.error(red(`ERROR: ${text}`)); }

function style(code, text) { return NO_COLOR ? text : `\x1b[${code}m${text}\x1b[0m`; }
function cyan(text) { return style(96, text); }
function magenta(text) { return style(95, text); }
function yellow(text) { return style(93, text); }
function red(text) { return style(91, text); }

/**
 * @typedef {object} DashSummaryEntry
 * @property {string} dependency
 * @property {string} license
 * @property {string} status
 * @property {string} source
 */