// https://github.com/npm/make-fetch-happen/issues/20
declare module 'make-fetch-happen';

// This whole thing is a huge complicated mess.
// Whenever Replicants are re-done, this will probably need to get thrown out.
// Right now it comes from our own fork here: https://github.com/Lange/json-schema-lib
// Upstream has been abandoned.
declare module 'json-schema-lib';
declare module 'json-schema-lib/lib/util/typeOf';
declare module 'json-schema-lib/lib/util/stripHash';
