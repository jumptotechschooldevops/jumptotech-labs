variable "environment" {
  type        = string
  description = "Deployment environment this configuration describes."
  default     = "prod"
}

variable "service_name" {
  type        = string
  description = "Name of the service this configuration manages."
}
