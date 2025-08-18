export enum ShowStatusElements {
  None,
  Spinner,
  ProgressBar,
  Completion
}

export type ProtocolStage = [
  name: string,
  description: string,
  show: ShowStatusElements
]
