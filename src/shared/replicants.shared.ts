// This file contains code that is used in both server-side and client-side replicants.
/* eslint-disable @typescript-eslint/no-dynamic-delete */
// Packages
import validator from 'is-my-json-valid';
import clone from 'clone';
import objectPath from 'object-path';
import { EventEmitter } from 'events';

// Ours
import { LoggerInterface } from './logger-interface';

/**
 * If you're wondering why some things are prefixed with "_",
 * but not marked as protected or private, this is because our Proxy
 * trap handlers need to access these parts of the Replicant internals,
 * but don't have access to private or protected members.
 *
 * So, we code this like its 2010 and just use "_" on some public members.
 */
export abstract class AbstractReplicant<T> extends EventEmitter {
	name: string;

	namespace: string;

	opts: Options<T>;

	revision = 0;

	log: LoggerInterface;

	schema?: { [k: string]: any };

	schemaSum?: string;

	status: 'undeclared' | 'declared' | 'declaring';

	validationErrors: validator.ValidationError[] = [];

	protected _value: T | undefined;

	protected _oldValue: T | undefined;

	protected _operationQueue: Array<Operation<T>> = [];

	protected _pendingOperationFlush: boolean;

	abstract get value(): T | undefined;
	abstract set value(newValue: T | undefined);

	constructor(name: string, namespace: string, opts: Options<T> = {}) {
		super();

		if (!name || typeof name !== 'string') {
			throw new Error('Must supply a name when instantiating a Replicant');
		}

		if (!namespace || typeof namespace !== 'string') {
			throw new Error('Must supply a namespace when instantiating a Replicant');
		}

		if (typeof opts.persistent === 'undefined') {
			opts.persistent = true;
		}

		if (typeof opts.persistenceInterval === 'undefined') {
			opts.persistenceInterval = DEFAULT_PERSISTENCE_INTERVAL;
		}

		this.name = name;
		this.namespace = namespace;
		this.opts = opts;

		// Prevents one-time change listeners from potentially being called twice.
		// https://github.com/nodecg/nodecg/issues/296
		const originalOnce = this.once.bind(this);
		this.once = (event, listener) => {
			if (event === 'change' && this.status === 'declared') {
				return listener(this.value);
			}

			return originalOnce(event, listener);
		};

		/**
		 * When a new "change" listener is added, chances are that the developer wants it to be initialized ASAP.
		 * However, if this replicant has already been declared previously in this context, their "change"
		 * handler will *not* get run until another change comes in, which may never happen for Replicants
		 * that change very infrequently.
		 * To resolve this, we immediately invoke all new "change" handlers if appropriate.
		 */
		this.on('newListener', (event, listener) => {
			if (event === 'change' && this.status === 'declared') {
				listener(this.value);
			}
		});
	}

	/**
	 * Adds an operation to the operation queue, to be flushed at the end of the current tick.
	 * @private
	 */
	abstract _addOperation(operation: Operation<T>): void;

	/**
	 * Emits all queued operations via Socket.IO & empties this._operationQueue.
	 * @private
	 */
	abstract _flushOperations(): void;

	/**
	 * If the operation is an array mutator method, call it on the target array with the operation arguments.
	 * Else, handle it with objectPath.
	 */
	_applyOperation(operation: Operation<T>): boolean {
		ignoreProxy(this);

		let result;
		const path = pathStrToPathArr(operation.path);
		if (ARRAY_MUTATOR_METHODS.includes(operation.method)) {
			if (typeof this.value !== 'object' || this.value === null) {
				throw new Error(
					`expected replicant "${this.namespace}:${
						this.name
					}" to have a value with type "object", got "${typeof this.value}" instead`,
				);
			}

			const arr: unknown = objectPath.get((this.value as unknown) as object, path);
			if (!Array.isArray(arr)) {
				throw new Error(
					`expected to find an array in replicant "${this.namespace}:${this.name}" at path "${operation.path}"`,
				);
			}

			result = arr[operation.method as any].apply(arr, operation.args);

			// Recursively check for any objects that may have been added by the above method
			// and that need to be Proxied.
			proxyRecursive(this, arr, operation.path);
		} else {
			switch (operation.method) {
				case 'overwrite': {
					const { newValue } = operation.args;
					this.value = proxyRecursive(this, newValue, operation.path);
					result = true;
					break;
				}

				case 'add':
				case 'update': {
					path.push(operation.args.prop);

					let { newValue } = operation.args;
					if (typeof newValue === 'object') {
						newValue = proxyRecursive(this, newValue, pathArrToPathStr(path));
					}

					result = objectPath.set(this.value as any, path, newValue);
					break;
				}

				case 'delete':
					// Workaround for https://github.com/mariocasciaro/object-path/issues/69
					if (path.length === 0 || objectPath.has(this.value as any, path)) {
						const target = objectPath.get(this.value as any, path);
						result = delete target[operation.args.prop];
					}

					break;
				/* istanbul ignore next */
				default:
					/* istanbul ignore next */
					throw new Error(`Unexpected operation method "${operation.method}"`);
			}
		}

		resumeProxy(this);
		return result;
	}

	/**
	 * Used to validate the new value of a replicant.
	 *
	 * This is a stub that will be replaced if a Schema is available.
	 */
	validate: Validator = (): boolean => {
		return true;
	};

	/**
	 * Generates a JSON Schema validator function from the `schema` property of the provided replicant.
	 * @param replicant {object} - The Replicant to perform the operation on.
	 * @returns {function} - The generated validator function.
	 */
	protected _generateValidator(): Validator {
		if (!this.schema) {
			throw new Error("can't generate a validator for a replicant which lacks a schema");
		}

		const validate = validator(this.schema as any, {
			greedy: true,
			verbose: true,
		});

		/**
		 * Validates a value against the current Replicant's schema.
		 * Throws when the value fails validation.
		 * @param [value=replicant.value] {*} - The value to validate. Defaults to the replicant's current value.
		 * @param [opts] {Object}
		 * @param [opts.throwOnInvalid = true] {Boolean} - Whether or not to immediately throw when the provided value fails validation against the schema.
		 */
		return function(
			this: AbstractReplicant<T>,
			value: any = this.value,
			{ throwOnInvalid = true }: ValidatorOptions = {},
		) {
			const result = validate(value);
			if (!result) {
				this.validationErrors = validate.errors;

				if (throwOnInvalid) {
					let errorMessage = `Invalid value rejected for replicant "${this.name}" in namespace "${this.namespace}":\n`;
					this.validationErrors.forEach(error => {
						const field = error.field.replace(/^data\./, '');
						if (error.message === 'is the wrong type') {
							errorMessage += `\tField "${field}" ${error.message}. Value "${String(
								error.value,
							)}" (type: ${typeof error.value}) was provided, expected type "${error.type}"\n `;
						} else if (error.message === 'has additional properties') {
							errorMessage += `\tField "${field}" ${error.message}: "${String(error.value)}"\n`;
						} else {
							errorMessage += `\tField "${field}" ${error.message}\n`;
						}
					});
					throw new Error(errorMessage);
				}
			}

			return result;
		};
	}
}

type Metadata<T> = {
	replicant: AbstractReplicant<T>;
	path: string;
	proxy: unknown;
};

export type Operation<T> = {
	path: string;
} & ( // Objects and arrays
	| { method: 'overwrite'; args: { newValue: T | undefined } }
	| { method: 'delete'; args: { prop: keyof T } }
	| { method: 'add'; args: { prop: string; newValue: any } }
	| { method: 'update'; args: { prop: string; newValue: any } }

	// Array mutator methods
	// This whole thing is gross and needs to be removed in v3
	// It is rife with unsupported cases, very easy to make bugs here
	| { method: 'copyWithin'; args: { prop: string; mutatorArgs: Parameters<any[]['copyWithin']> } }
	| { method: 'fill'; args: { prop: string; mutatorArgs: Parameters<any[]['fill']> } }
	| { method: 'pop'; args: { prop: string } }
	| { method: 'push'; args: { prop: string; mutatorArgs: Parameters<any[]['push']> } }
	| { method: 'reverse'; args: { prop: string } }
	| { method: 'shift'; args: { prop: string } }
	| { method: 'sort'; args: { prop: string; mutatorArgs: Parameters<any[]['sort']> } }
	| { method: 'splice'; args: { prop: string; mutatorArgs: Parameters<any[]['splice']> } }
	| { method: 'unshift'; args: { prop: string; mutatorArgs: Parameters<any[]['unshift']> } }
);

export type Options<T> = { persistent?: boolean; persistenceInterval?: number; schemaPath?: string; defaultValue?: T };

export type ValidatorOptions = {
	throwOnInvalid?: boolean;
};

export type Validator = (newValue: any, opts?: ValidatorOptions) => boolean;

const proxyMetadataMap = new WeakMap();
const metadataMap = new WeakMap<any, Metadata<any>>();
const proxySet = new WeakSet();
const ignoringProxy = new WeakSet<AbstractReplicant<any>>();

export const ARRAY_MUTATOR_METHODS = [
	'copyWithin',
	'fill',
	'pop',
	'push',
	'reverse',
	'shift',
	'sort',
	'splice',
	'unshift',
];

/**
 * The default persistence interval, in milliseconds.
 */
const DEFAULT_PERSISTENCE_INTERVAL = 100;

export function ignoreProxy(replicant: AbstractReplicant<any>): void {
	ignoringProxy.add(replicant);
}

export function resumeProxy(replicant: AbstractReplicant<any>): void {
	ignoringProxy.delete(replicant);
}

export function isIgnoringProxy(replicant: AbstractReplicant<any>): boolean {
	return ignoringProxy.has(replicant);
}

const deleteTrap = function<T>(target: T, prop: keyof T): boolean | void {
	const metadata = metadataMap.get(target);
	if (!metadata) {
		throw new Error('arrived at delete trap without any metadata');
	}

	const { replicant } = metadata;

	if (isIgnoringProxy(replicant)) {
		return delete target[prop];
	}

	// If the target doesn't have this prop, return true.
	if (!{}.hasOwnProperty.call(target, prop)) {
		return true;
	}

	if (replicant.schema) {
		const valueClone = clone(replicant.value);
		const targetClone = objectPath.get(valueClone, pathStrToPathArr(metadata.path));
		delete targetClone[prop];
		replicant.validate(valueClone);
	}

	replicant._addOperation({ path: metadata.path, method: 'delete', args: { prop } });
	if (!process.env.BROWSER) {
		return delete target[prop];
	}
};

const CHILD_ARRAY_HANDLER = {
	get<T>(target: T, prop: keyof T) {
		const metadata = metadataMap.get(target);
		if (!metadata) {
			throw new Error('arrived at get trap without any metadata');
		}

		const { replicant } = metadata;
		if (isIgnoringProxy(replicant)) {
			return target[prop];
		}

		if (
			{}.hasOwnProperty.call(Array.prototype, prop) &&
			typeof Array.prototype[prop as any] === 'function' &&
			target[prop] === Array.prototype[prop as any] &&
			ARRAY_MUTATOR_METHODS.indexOf(prop as any) >= 0
		) {
			return (...args: any[]) => {
				if (replicant.schema) {
					const valueClone = clone(replicant.value);
					const targetClone = objectPath.get(valueClone, pathStrToPathArr(metadata.path));
					targetClone[prop].apply(targetClone, args);
					replicant.validate(valueClone);
				}

				if (process.env.BROWSER) {
					metadata.replicant._addOperation({
						path: metadata.path,
						method: prop as any,
						args: Array.prototype.slice.call(args),
					});
				} else {
					ignoreProxy(replicant);
					metadata.replicant._addOperation({
						path: metadata.path,
						method: prop as any,
						args: Array.prototype.slice.call(args),
					});
					const retValue = (target as any)[prop].apply(target, args);
					resumeProxy(replicant);

					// We have to re-proxy the target because the items could have been inserted.
					proxyRecursive(replicant, target, metadata.path);

					// TODO: This could leak a non-proxied object and cause bugs!
					return retValue;
				}
			};
		}

		return target[prop];
	},

	set<T>(target: T, prop: keyof T, newValue: any) {
		if (target[prop] === newValue) {
			return true;
		}

		const metadata = metadataMap.get(target);
		if (!metadata) {
			throw new Error('arrived at set trap without any metadata');
		}

		const { replicant } = metadata;

		if (isIgnoringProxy(replicant)) {
			target[prop] = newValue;
			return true;
		}

		if (replicant.schema) {
			const valueClone = clone(replicant.value);
			const targetClone = objectPath.get(valueClone, pathStrToPathArr(metadata.path));
			targetClone[prop] = newValue;
			replicant.validate(valueClone);
		}

		// It is crucial that this happen *before* the assignment below.
		if ({}.hasOwnProperty.call(target, prop)) {
			replicant._addOperation({
				path: metadata.path,
				method: 'update',
				args: {
					prop: prop as string,
					newValue,
				},
			});
		} else {
			replicant._addOperation({
				path: metadata.path,
				method: 'add',
				args: {
					prop: prop as string,
					newValue,
				},
			});
		}

		// If this Replicant is running in the server context, immediately apply the value.
		if (!process.env.BROWSER) {
			target[prop] = proxyRecursive(metadata.replicant, newValue, joinPathParts(metadata.path, prop as string));
		}

		return true;
	},

	deleteProperty: deleteTrap,
};

const CHILD_OBJECT_HANDLER = {
	get<T>(target: T, prop: keyof T) {
		const value = target[prop];

		const tag = Object.prototype.toString.call(value);
		const shouldBindProperty =
			prop !== 'constructor' &&
			(tag === '[object Function]' || tag === '[object AsyncFunction]' || tag === '[object GeneratorFunction]');

		if (shouldBindProperty) {
			return (value as any).bind(target);
		}

		return value;
	},

	set<T>(target: T, prop: keyof T, newValue: any) {
		if (target[prop] === newValue) {
			return true;
		}

		const metadata = metadataMap.get(target);
		if (!metadata) {
			throw new Error('arrived at set trap without any metadata');
		}

		const { replicant } = metadata;

		if (isIgnoringProxy(replicant)) {
			target[prop] = newValue;
			return true;
		}

		if (replicant.schema) {
			const valueClone = clone(replicant.value);
			const targetClone = objectPath.get(valueClone, pathStrToPathArr(metadata.path));
			targetClone[prop] = newValue;
			replicant.validate(valueClone);
		}

		// It is crucial that this happen *before* the assignment below.
		if ({}.hasOwnProperty.call(target, prop)) {
			replicant._addOperation({
				path: metadata.path,
				method: 'update',
				args: {
					prop: prop as string,
					newValue,
				},
			});
		} else {
			replicant._addOperation({
				path: metadata.path,
				method: 'add',
				args: {
					prop: prop as string,
					newValue,
				},
			});
		}

		// If this Replicant is running in the server context, immediately apply the value.
		if (!process.env.BROWSER) {
			target[prop] = proxyRecursive(metadata.replicant, newValue, joinPathParts(metadata.path, prop as string));
		}

		return true;
	},

	deleteProperty: deleteTrap,
};

/**
 * Recursively Proxies an Array or Object. Does nothing to primitive values.
 * @param replicant {object} - The Replicant in which to do the work.
 * @param value {*} - The value to recursively Proxy.
 * @param path {string} - The objectPath to this value.
 * @returns {*} - The recursively Proxied value (or just `value` unchanged, if `value` is a primitive)
 * @private
 */
export function proxyRecursive<T>(replicant: AbstractReplicant<any>, value: T, path: string): T {
	if (typeof value === 'object' && value !== null) {
		let p;

		assertSingleOwner(replicant, value);

		// If "value" is already a Proxy, don't re-proxy it.
		if (proxySet.has(value as any)) {
			p = value;
			const metadata = proxyMetadataMap.get(value as any);
			metadata.path = path; // Update the path, as it may have changed.
		} else if (metadataMap.has(value)) {
			const metadata = metadataMap.get(value);
			if (!metadata) {
				throw new Error('metadata unexpectedly not found');
			}

			p = metadata.proxy;
			metadata.path = path; // Update the path, as it may have changed.
		} else {
			const handler = Array.isArray(value) ? CHILD_ARRAY_HANDLER : CHILD_OBJECT_HANDLER;
			p = new Proxy(value as any, handler as any);
			proxySet.add(p);
			const metadata = {
				replicant,
				path,
				proxy: p,
			};
			metadataMap.set(value, metadata);
			proxyMetadataMap.set(p, metadata);
		}

		for (const key in value) {
			/* istanbul ignore if */
			if (!{}.hasOwnProperty.call(value, key)) {
				continue;
			}

			const escapedKey = key.replace(/\//g, '~1');
			if (path) {
				const joinedPath = joinPathParts(path, escapedKey);
				value[key] = proxyRecursive(replicant, value[key], joinedPath);
			} else {
				value[key] = proxyRecursive(replicant, value[key], escapedKey);
			}
		}

		return p;
	}

	return value;
}

function joinPathParts(part1: string, part2: string): string {
	return part1.endsWith('/') ? `${part1}${part2}` : `${part1}/${part2}`;
}

/**
 * Converts a string path (/a/b/c) to an array path ['a', 'b', 'c']
 * @param path {String} - The path to convert.
 * @returns {Array} - The converted path.
 */
function pathStrToPathArr(path: string): string[] {
	const pathArr = path
		.substr(1)
		.split('/')
		.map(part => {
			// De-tokenize '/' characters in path name
			return part.replace(/~1/g, '/');
		});

	// For some reason, path arrays whose only item is an empty string cause errors.
	// In this case, we replace the path with an empty array, which seems to be fine.
	if (pathArr.length === 1 && pathArr[0] === '') {
		return [];
	}

	return pathArr;
}

/**
 * Converts an array path ['a', 'b', 'c'] to a string path /a/b/c)
 * @param path {Array} - The path to convert.
 * @returns {String} - The converted path.
 */
function pathArrToPathStr(path: string[]): string {
	const strPath = path.join('/');
	if (strPath.charAt(0) !== '/') {
		return `/${strPath}`;
	}

	return strPath;
}

/**
 * Throws an exception if an object belongs to more than one Replicant.
 * @param replicant {object} - The Replicant that this value should belong to.
 * @param value {*} - The value to check ownership of.
 */
function assertSingleOwner(replicant: AbstractReplicant<any>, value: any) {
	let metadata;
	if (proxySet.has(value)) {
		metadata = proxyMetadataMap.get(value);
	} else if (metadataMap.has(value)) {
		metadata = metadataMap.get(value);
	} else {
		// If there's no metadata for this value, then it doesn't belong to any Replicants yet,
		// and we're okay to continue.
		return;
	}

	if (metadata.replicant !== replicant) {
		throw new Error(
			`This object belongs to another Replicant, ${metadata.replicant.namespace}::${metadata.replicant.name}.` +
				`\nA given object cannot belong to multiple Replicants. Object value:\n${JSON.stringify(
					value,
					null,
					2,
				)}`,
		);
	}
}