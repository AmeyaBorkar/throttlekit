/**
 * DynamoDB backend for ThrottleKit — an exact, lock-free store built on DynamoDB's conditional
 * writes (optimistic concurrency on a `version` attribute). See {@link DynamoStore}.
 */
export { DynamoStore } from "./store";
export type {
  DynamoClientLike,
  DynamoDeleteInput,
  DynamoGetInput,
  DynamoPutInput,
  DynamoStoreOptions,
} from "./store";
