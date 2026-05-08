export const retryPromise = <T>(
  fn: () => Promise<T>,
  retries: number,
  delay: number,
) => {
  return new Promise<T>((resolve, reject) => {
    function attempt() {
      fn()
        .then(resolve)
        .catch((error: unknown) => {
          if (retries > 0) {
            --retries;
            setTimeout(attempt, delay);
          } else {
            reject(error);
          }
        });
    }
    attempt();
  });
};
