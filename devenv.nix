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

  # See full reference at https://devenv.sh/reference/options/
}
