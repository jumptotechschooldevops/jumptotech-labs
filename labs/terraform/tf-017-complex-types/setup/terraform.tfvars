# Supplied by the platform team. This file is their interface to you: they
# maintain it, and it now describes every environment rather than one.
#
# Note that `production` says nothing about debug. That is deliberate — most
# environments do not, and the ones that do are the exception.

target = "production"

environments = {
  staging = {
    region   = "eu-west-1"
    replicas = 2
    debug    = true
  }

  production = {
    region   = "eu-central-1"
    replicas = 6
  }
}
