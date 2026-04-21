{ lib, ... }:
let
  firstnames = [
    "tal"
    "cliff"
    "bobby"
    "red"
    "jack"
    "james"
    "matt"
    "ted"
    "hank"
    "johnny"
    "don"
    "bill"
    "ken"
    "nelson"
    "roy"
    "john"
    "pete"
    "bob"
    "clint"
    "dick"
    "chuck"
    "herb"
    "george"
    "harry"
    "larry"
    "joe"
    "hoot"
    "ferris"
    "alice"
    "ann"
    "anna"
    "donna"
    "eva"
    "frances"
    "max"
    "helen"
    "jane"
    "janet"
    "joan"
    "joyce"
    "june"
    "kay"
    "marian"
    "mary"
    "rita"
    "sophie"
    "mo"
  ];

  lastnames1 = [
    "tinkle"
    "wiggle"
    "flutter"
    "farber"
    "snelle"
    "sparkle"
    "glimmer"
    "glitter"
    "ribbon"
    "feather"
    "tickle"
    "flicker"
    "winkle"
    "whisper"
    "color"
    "silver"
    "shimmer"
    "murmer"
    "meadow"
    "wobble"
    "nibble"
    "rustle"
    "snuggle"
    "sputter"
    "tattle"
    "fiddle"
    "cinder"
    "marrow"
    "pebble"
    "petal"
    "river"
    "velvet"
    "button"
    "softer"
    "shiver"
  ];

  lastnames2 = [
    "son"
    "smith"
    "man"
    "sen"
    "ovich"
    "poulos"
    "ides"
    "ton"
    "ford"
    "ham"
    "ski"
    "berg"
    "er"
    "mann"
    "hard"
    "ward"
    "wyn"
    "kin"
    "ling"
    "let"
    "snelle"
    "spark"
    "wind"
    "bolt"
    "flame"
    "star"
    "moon"
    "sun"
    "bell"
    "snell"
    "flick"
    "bark"
    "shine"
    "iron"
    "coal"
    "stone"
    "moss"
    "bone"
    "wood"
    "leaf"
    "twig"
    "branch"
    "root"
    "trunk"
    "pine"
    "oak"
    "gem"
    "glow"
    "toe"
    "tooth"
    "gold"
  ];

  bashArray = words: lib.concatStringsSep " " (map lib.escapeShellArg words);
in
{
  home-manager.users.bdsqqq = { pkgs, ... }: {
    home.packages = [
      (pkgs.writeScriptBin "fairy-name" ''
        #!${pkgs.bash}/bin/bash
        set -euo pipefail
        firstnames=( ${bashArray firstnames} )
        lastnames1=( ${bashArray lastnames1} )
        lastnames2=( ${bashArray lastnames2} )
        nf=''${#firstnames[@]}
        n1=''${#lastnames1[@]}
        n2=''${#lastnames2[@]}

        # deterministic index from seed + slot (0, 1, 2); same seed → same name
        hash_seed() {
          local input="$1"
          local hash=5381
          local i char ord

          for ((i = 0; i < ''${#input}; i++)); do
            char=''${input:i:1}
            printf -v ord '%d' "'$char"
            hash=$((((hash * 33) + ord) & 0x7fffffff))
          done

          printf '%s\n' "$hash"
        }

        pick() {
          local seed="$1"
          local slot="$2"
          local max="$3"
          local h
          h=$(hash_seed "$seed|$slot")
          echo $((h % max))
        }

        if [[ $# -ge 1 ]]; then
          seed="$*"
          i=$(pick "$seed" 0 "$nf")
          j=$(pick "$seed" 1 "$n1")
          k=$(pick "$seed" 2 "$n2")
        else
          i=$((RANDOM % nf))
          j=$((RANDOM % n1))
          k=$((RANDOM % n2))
        fi

        printf '%s\n' "''${firstnames[i]}_''${lastnames1[j]}''${lastnames2[k]}"
      '')
    ];
  };
}
