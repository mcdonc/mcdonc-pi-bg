{
  pkgs,
  lib,
  config,
  ...
}:
{
  # https://devenv.sh/languages/
  languages = {
    javascript = {
      enable = true;
      npm = {
        enable = true;
        install = {
          enable = true;
        };
      };
    };
  };

  scripts.tests.exec = ''
    node --experimental-strip-types --test --test-timeout=10000 lib.test.ts "$@"
  '';

  scripts.runpi.exec = ''
    pi --extension ./index.ts "$@"
  '';

  # See full reference at https://devenv.sh/reference/options/
}
