// Native
import * as fs from 'fs';
import * as path from 'path';

// Packages
import express from 'express';
import chokidar from 'chokidar';
import multer from 'multer';
import sha1File from 'sha1-file';

// Ours
import AssetFile from './AssetFile';
import { authCheck, debounceName } from '../util';
import * as bundlesLib from '../bundle-manager';
import createLogger from '../logger';
import Replicant from '../replicant';
import Replicator from '../replicant/replicator';

type Collection = {
	name: string;
	categories: NodeCG.Bundle.AssetCategory[];
};

export default class AssetManager {
	readonly log = createLogger('nodecg/lib/assets');

	readonly assetsRoot = path.join(process.env.NODECG_ROOT, 'assets');

	readonly collectionsRep: Replicant<Collection[]>;

	readonly app: Express.Application;

	private readonly _repsByNamespace = new Map<string, Map<string, Replicant<AssetFile[]>>>();

	constructor(replicator: Replicator) {
		// Create assetsRoot folder if it does not exist.
		/* istanbul ignore next: Simple directory creation. */
		if (!fs.existsSync(this.assetsRoot)) {
			fs.mkdirSync(this.assetsRoot);
		}

		this.collectionsRep = replicator.findOrDeclare('collections', '_assets', {
			defaultValue: [],
			persistent: false,
		});

		const { watchPatterns } = this._computeCollections(bundlesLib.all());
		this._setupWatcher(watchPatterns);
		this.app = this._setupExpress();
	}

	private _computeCollections(bundles: NodeCG.Bundle[]): { collections: Collection[]; watchPatterns: Set<string> } {
		const watchPatterns = new Set<string>();
		const collections: Collection[] = [];
		bundles.forEach(bundle => {
			if (!bundle.hasAssignableSoundCues && (!bundle.assetCategories || bundle.assetCategories.length <= 0)) {
				return;
			}

			// If this bundle has sounds && at least one of those sounds is assignable, create the assets:sounds replicant.
			if (bundle.hasAssignableSoundCues) {
				bundle.assetCategories.unshift({
					name: 'sounds',
					title: 'Sounds',
					allowedTypes: ['mp3', 'ogg'],
				});
			}

			collections.push({
				name: bundle.name,
				categories: bundle.assetCategories,
			});
		});

		collections.forEach(({ name, categories }) => {
			const namespacedAssetsPath = this._calcNamespacedAssetsPath(name);
			const collectionReps = new Map<string, Replicant<AssetFile[]>>();
			this._repsByNamespace.set(name, collectionReps);
			this.collectionsRep.value!.push({ name, categories });

			for (const category of categories) {
				/* istanbul ignore next: Simple directory creation. */
				const categoryPath = path.join(namespacedAssetsPath, category.name);
				if (!fs.existsSync(categoryPath)) {
					fs.mkdirSync(categoryPath);
				}

				collectionReps.set(
					category.name,
					new Replicant<AssetFile[]>(`assets:${category.name}`, name, {
						defaultValue: [],
						persistent: false,
					}),
				);

				if (category.allowedTypes && category.allowedTypes.length > 0) {
					category.allowedTypes.forEach(type => {
						watchPatterns.add(`${categoryPath}/**/*.${type}`);
					});
				} else {
					watchPatterns.add(`${categoryPath}/**/*`);
				}
			}
		});

		return { collections, watchPatterns };
	}

	private _setupWatcher(watchPatterns: Set<string>): void {
		// Chokidar no longer accepts Windows-style path separators when using globs.
		// Therefore, we must replace them with Unix-style ones.
		// See https://github.com/paulmillr/chokidar/issues/777 for more details.
		const fixedPaths = Array.from(watchPatterns).map(pattern => pattern.replace(/\\/g, '/'));
		const watcher = chokidar.watch(fixedPaths, { ignored: /[/\\]\./ });

		/* When the Chokidar watcher first starts up, it will fire an 'add' event for each file found.
		 * After that, it will emit the 'ready' event.
		 * To avoid thrashing the replicant, we want to add all of these first files at once.
		 * This is what the ready Boolean, deferredFiles Map, and resolveDeferreds function are for.
		 */
		let ready = false;
		const deferredFiles = new Map<string, AssetFile | null>();
		watcher.on('add', filepath => {
			if (!ready) {
				deferredFiles.set(filepath, null);
			}

			sha1File(filepath, (err, sum) => {
				if (err) {
					if (deferredFiles) {
						deferredFiles.delete(filepath);
					}

					this.log.error(err);
					return;
				}

				const uploadedFile = new AssetFile(filepath, sum);
				if (deferredFiles) {
					deferredFiles.set(filepath, uploadedFile);
					this._resolveDeferreds(deferredFiles);
				} else {
					const rep = this._getCollectRep(uploadedFile.namespace, uploadedFile.category);
					if (rep) {
						rep.value!.push(uploadedFile);
					}
				}
			});
		});

		watcher.on('ready', () => {
			ready = true;
		});

		watcher.on('change', filepath => {
			debounceName(filepath, () => {
				sha1File(filepath, (err, sum) => {
					if (err) {
						this.log.error(err);
						return;
					}

					const newUploadedFile = new AssetFile(filepath, sum);
					const rep = this._getCollectRep(newUploadedFile.namespace, newUploadedFile.category);
					if (!rep) {
						throw new Error('should have had a replicant here');
					}

					const index = rep.value!.findIndex(uf => uf.url === newUploadedFile.url);
					if (index > -1) {
						rep.value!.splice(index, 1, newUploadedFile);
					} else {
						rep.value!.push(newUploadedFile);
					}
				});
			});
		});

		watcher.on('unlink', filepath => {
			const deletedFile = new AssetFile(filepath, 'temp');
			const rep = this._getCollectRep(deletedFile.namespace, deletedFile.category);
			if (!rep) {
				return;
			}

			rep.value!.some((assetFile, index) => {
				if (assetFile.url === deletedFile.url) {
					rep.value!.splice(index, 1);
					this.log.debug('"%s" was deleted', deletedFile.url);
					return true;
				}

				return false;
			});
		});

		watcher.on('error', e => this.log.error(e.stack));
	}

	private _setupExpress(): Express.Application {
		const app = express();
		const upload = multer({
			storage: multer.diskStorage({
				destination: this.assetsRoot,
				filename(req, _file, cb) {
					const p = req.params as { [k: string]: string };
					cb(null, `${p.namespace}/${p.category}/${p.filePath}`);
				},
			}),
		});
		const uploader = upload.array('file', 64);

		// Retrieving existing files
		app.get(
			'/assets/:namespace/:category/:filePath',

			// Check if the user is authorized.
			authCheck,

			// Send the file (or an appropriate error).
			(req, res) => {
				const fullPath = path.join(
					this.assetsRoot,
					req.params.namespace,
					req.params.category,
					req.params.filePath,
				);
				res.sendFile(fullPath, (err: NodeJS.ErrnoException) => {
					if (err && !res.headersSent) {
						if (err.code === 'ENOENT') {
							return res.sendStatus(404);
						}

						this.log.error(`Unexpected error sending file ${fullPath}`, err);
						return res.sendStatus(500);
					}

					return undefined;
				});
			},
		);

		// Uploading new files
		app.post(
			'/assets/:namespace/:category/:filePath',

			// Check if the user is authorized.
			authCheck,

			// Then receive the files they are sending, up to a max of 64.
			(req, res, next) => {
				uploader(req, res, err => {
					if (err) {
						console.error(err);
						res.send(500);
						return;
					}

					next();
				});
			},

			// Then send a response.
			(req, res) => {
				if (req.files) {
					res.status(200).send('Success');
				} else {
					res.status(400).send('Bad Request');
				}
			},
		);

		// Deleting existing files
		app.delete(
			'/assets/:namespace/:category/:filename',

			// Check if the user is authorized.
			authCheck,

			// Delete the file (or an send appropriate error).
			(req, res) => {
				const { namespace, category, filename } = req.params as { [k: string]: string };
				const fullPath = path.join(this.assetsRoot, namespace, category, filename);

				fs.unlink(fullPath, err => {
					if (err) {
						if (err.code === 'ENOENT') {
							return res.status(410).send(`The file to delete does not exist: ${filename}`);
						}

						this.log.error(`Failed to delete file ${fullPath}`, err);
						return res.status(500).send(`Failed to delete file: ${filename}`);
					}

					return res.sendStatus(200);
				});
			},
		);

		return app;
	}

	private _calcNamespacedAssetsPath(namespace: string): string {
		const assetsPath = path.join(this.assetsRoot, namespace);
		/* istanbul ignore next: Simple directory creation. */
		if (!fs.existsSync(assetsPath)) {
			fs.mkdirSync(assetsPath);
		}

		return assetsPath;
	}

	private _resolveDeferreds(deferredFiles: Map<string, AssetFile | null>): void {
		let foundNull = false;
		deferredFiles.forEach(uf => {
			if (uf === null) {
				foundNull = true;
			}
		});

		if (!foundNull) {
			deferredFiles.forEach(uploadedFile => {
				if (!uploadedFile) {
					return;
				}

				const rep = this._getCollectRep(uploadedFile.namespace, uploadedFile.category);
				if (rep) {
					rep.value!.push(uploadedFile);
				}
			});
			deferredFiles.clear();
		}
	}

	private _getCollectRep(namespace: string, category: string): Replicant<AssetFile[]> | undefined {
		const nspReps = this._repsByNamespace.get(namespace);
		if (nspReps) {
			return nspReps.get(category);
		}

		return undefined;
	}
}
