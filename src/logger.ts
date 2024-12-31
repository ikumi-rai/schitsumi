import pino from "pino"

/**
 * 標準出力とファイルの両方にログを出力
 * @param name ファイル名
 */
export const createLogger = (name: string) =>
  pino({
    level: "trace",
    base: undefined,
    transport: {
      targets: [
        {
          target: "pino-pretty",
          options: {
            sync: true,
          },
        },
        {
          target: "pino/file",
          options: {
            destination: `logs/${name}.log`,
            mkdir: true,
            sync: true,
          },
        },
      ],
    },
  })
