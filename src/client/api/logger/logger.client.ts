// Native
import { format, inspect } from 'util';

// Packages
import * as Sentry from '@sentry/browser';

// Ours
import { LoggerInterface, LogLevel } from '../../../shared/logger-interface';

const OrderedLogLevels: { [Level in LogLevel]: number } = {
	verbose: 0,
	debug: 1,
	info: 2,
	warn: 3,
	error: 4,
};

type LoggerOptions = {
	console: {
		enabled: boolean;
		level: LogLevel;
	};
	replicants: boolean;
};

/**
 * A factory that configures and returns a Logger constructor.
 *
 * @returns  A constructor used to create discrete logger instances.
 */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export default function(initialOpts: LoggerOptions, sentry?: typeof Sentry) {
	initialOpts = initialOpts || {};
	initialOpts.console = initialOpts.console || {};

	/**
	 * Constructs a new Logger instance that prefixes all output with the given name.
	 * @param name {String} - The label to prefix all output of this logger with.
	 * @returns {Object} - A Logger instance.
	 * @constructor
	 */
	class Logger implements LoggerInterface {
		// A messy bit of internal state used to determine if the special-case "replicants" logging level is active.
		static _shouldLogReplicants = Boolean(initialOpts.replicants);

		static _silent = true;

		static _level: LogLevel = LogLevel.Info;

		name: string;

		constructor(name: string) {
			this.name = name;
		}

		static globalReconfigure(opts: LoggerOptions): void {
			_configure(opts);
		}

		trace(...args: any[]): void {
			if (Logger._silent) {
				return;
			}

			if (OrderedLogLevels[Logger._level] > OrderedLogLevels.verbose) {
				return;
			}

			console.info(`[${this.name}]`, ...args);
		}

		debug(...args: any[]): void {
			if (Logger._silent) {
				return;
			}

			if (OrderedLogLevels[Logger._level] > OrderedLogLevels.debug) {
				return;
			}

			console.info(`[${this.name}]`, ...args);
		}

		info(...args: any[]): void {
			if (Logger._silent) {
				return;
			}

			if (OrderedLogLevels[Logger._level] > OrderedLogLevels.info) {
				return;
			}

			console.info(`[${this.name}]`, ...args);
		}

		warn(...args: any[]): void {
			if (Logger._silent) {
				return;
			}

			if (OrderedLogLevels[Logger._level] > OrderedLogLevels.warn) {
				return;
			}

			console.warn(`[${this.name}]`, ...args);
		}

		error(...args: any[]): void {
			if (Logger._silent) {
				return;
			}

			if (OrderedLogLevels[Logger._level] > OrderedLogLevels.error) {
				return;
			}

			console.error(`[${this.name}]`, ...args);

			if (sentry) {
				const formattedArgs = args.map(argument => {
					return typeof argument === 'object'
						? inspect(argument, { depth: null, showProxy: true })
						: argument;
				});

				sentry.captureException(
					new Error(`[${this.name}] ` + format(formattedArgs[0], ...formattedArgs.slice(1))),
				);
			}
		}

		replicants(...args: any[]): void {
			if (Logger._silent) {
				return;
			}

			if (!Logger._shouldLogReplicants) {
				return;
			}

			console.info(`[${this.name}]`, ...args);
		}
	}

	_configure(initialOpts);

	function _configure(opts: LoggerOptions): void {
		// Initialize opts with empty objects, if nothing was provided.
		opts = opts || {};
		opts.console = opts.console || {};

		if (typeof opts.console.enabled !== 'undefined') {
			Logger._silent = !opts.console.enabled;
		}

		if (typeof opts.console.level !== 'undefined') {
			Logger._level = opts.console.level;
		}

		if (typeof opts.replicants !== 'undefined') {
			Logger._shouldLogReplicants = opts.replicants;
		}
	}

	const typedExport: new (name: string) => LoggerInterface = Logger;
	return typedExport;
}
